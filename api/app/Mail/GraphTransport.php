<?php

namespace App\Mail;

use Closure;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use InvalidArgumentException;
use Symfony\Component\Mailer\Exception\TransportException;
use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Transport\AbstractTransport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;
use Throwable;

/**
 * The `graph` mailer (config/mail.php): mail through Microsoft Graph, as the one mailbox in
 * MAIL_FROM_ADDRESS, signed in as the server's user-assigned managed identity
 * (MAIL_GRAPH_CLIENT_ID). There is no secret: the token comes from the server's metadata
 * endpoint. What the platform and Exchange Online provide: deploy/README.md, "Mail through
 * Microsoft Graph".
 *
 * - The token: a GET to the metadata endpoint (169.254.169.254, plain HTTP, reachable from the
 *   server only), with the header `Metadata: true`, never through a proxy and never redirected.
 *   Only api and the scheduler may reach it (deploy/scripts/metadata-access.sh).
 * - It is kept in the cache store (in production the database's `cache` table, shared by api
 *   and the scheduler), encrypted with APP_KEY, until TOKEN_MARGIN seconds before it expires; a
 *   401 or 403 from Graph drops it.
 * - JSON, never MIME: only the JSON form takes "saveToSentItems": false, so the mailbox keeps no
 *   copy of a code. Graph saves every MIME message to Sent Items.
 * - Every request is bounded (CONNECT_TIMEOUT, TIMEOUT) and never follows a redirect. No
 *   retries: two-factor and e-mail-change codes go out inside the app's request, which gives up
 *   after 15 seconds.
 * - A failure is a TransportException (AccountController catches that interface) that names the
 *   request, the HTTP status and the endpoint's error code; the same is logged at error level
 *   with a hint, because the callers log the exception class only (F-38). Never in a message or
 *   a log line: the token, the subject, the body (it carries the code) or a recipient.
 * - Only what the app sends (plain text, no attachments, from the mailbox itself): anything else
 *   is refused before a request.
 */
final class GraphTransport extends AbstractTransport
{
    /** The metadata endpoint's token route (Azure Instance Metadata Service). */
    public const TOKEN_URL = 'http://169.254.169.254/metadata/identity/oauth2/token';

    public const TOKEN_API_VERSION = '2018-02-01';

    public const RESOURCE = 'https://graph.microsoft.com';

    public const SEND_URL = 'https://graph.microsoft.com/v1.0/users/%s/sendMail';

    /** Seconds to connect, and for a whole request, connect included. */
    public const CONNECT_TIMEOUT = 3;

    public const TIMEOUT = 5;

    /** The cached token is dropped this many seconds before it expires. */
    public const TOKEN_MARGIN = 300;

    /** A token with less time than this left after the margin is used once, not cached. */
    public const MIN_CACHE_SECONDS = 60;

    public const LOG_PREFIX = '[mail-graph]';

    private const GUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /** What an error code may look like to be logged; anything else is `unknown`. */
    private const CODE = '/^[A-Za-z0-9_.-]{1,64}$/';

    /** A fixed hint per kind of failure, for whoever reads the log. */
    private const HINTS = [
        'settings' => 'set MAIL_GRAPH_CLIENT_ID (the managed identity\'s client ID) and MAIL_FROM_ADDRESS (deploy/README.md, Settings)',
        'identity' => 'the metadata endpoint knows no such identity: is it attached to the server, and is MAIL_GRAPH_CLIENT_ID its client ID?',
        'updating' => 'the metadata endpoint is updating (just after a boot, for example); mail works again within a minute or two',
        'refused' => 'the metadata endpoint refused the request (a proxy in between, or the Metadata header missing)',
        'token refused' => 'Graph refused the access token; the next mail asks for a new one',
        'permission' => 'Graph refused to send as MAIL_FROM_ADDRESS: check the "Application Mail.Send" role assignment and its scope (it can take up to two hours to apply)',
        'mailbox' => 'Graph does not know MAIL_FROM_ADDRESS as a mailbox of the tenant',
        'throttled' => 'throttled; mail works again after Retry-After',
        'unavailable' => 'the metadata endpoint or Microsoft Graph answered with a server error',
        'no answer' => 'no answer within the time limit: api and the scheduler must reach the metadata endpoint and Graph (deploy/README.md)',
        'unexpected' => 'an answer the transport does not expect',
    ];

    public function __construct(
        private readonly string $clientId,
        private readonly string $mailbox,
    ) {
        parent::__construct();

        $invalid = [];
        if (preg_match(self::GUID, $clientId) !== 1) {
            $invalid[] = 'MAIL_GRAPH_CLIENT_ID';
        }
        if (filter_var($mailbox, FILTER_VALIDATE_EMAIL) === false) {
            $invalid[] = 'MAIL_FROM_ADDRESS';
        }
        if ($invalid !== []) {
            Log::error(self::LOG_PREFIX.' mail settings missing or invalid', ['settings' => $invalid, 'hint' => self::HINTS['settings']]);

            throw new InvalidArgumentException('Microsoft Graph mail: settings missing or invalid: '.implode(', ', $invalid));
        }
    }

    /** The transport of the `graph` mailer: its config (config/mail.php) and the global sender. */
    public static function fromConfig(array $config, mixed $mailbox): self
    {
        return new self(self::text($config['client_id'] ?? null), self::text($mailbox));
    }

    public function __toString(): string
    {
        // CodeMail reads this name: it refuses the log transport and chains that contain it.
        return 'graph';
    }

    protected function doSend(SentMessage $message): void
    {
        $payload = $this->payload($message->getOriginalMessage());
        $token = $this->token();

        $response = $this->call('send', fn () => $this->http()
            ->withToken($token)
            ->asJson()
            ->post(sprintf(self::SEND_URL, self::pathAddress($this->mailbox)), $payload));

        if ($response->status() === 202) {
            return;
        }
        if (in_array($response->status(), [401, 403], true)) {
            // A token Graph refuses is useless; after a fix the next mail gets a new one at once.
            $this->forgetToken();
        }

        throw $this->failure('send', $response);
    }

    /**
     * The JSON body of sendMail, or a refusal before any request: only plain text without
     * attachments, from the mailbox itself. A message without any recipient never gets here:
     * Symfony refuses it before a transport runs (Email::ensureValidity).
     *
     * @return array<string, mixed>
     */
    private function payload(mixed $original): array
    {
        if (! $original instanceof Email) {
            throw $this->refusal('only plain-text e-mail messages are sent');
        }
        $text = $original->getTextBody();
        if ($original->getHtmlBody() !== null || $original->getAttachments() !== [] || ! is_string($text) || $text === '') {
            throw $this->refusal('only plain-text mails without attachments are sent');
        }
        $from = $original->getFrom();
        if (count($from) !== 1 || strcasecmp($from[0]->getAddress(), $this->mailbox) !== 0) {
            throw $this->refusal('the sender must be MAIL_FROM_ADDRESS');
        }

        $sender = ['address' => $this->mailbox];
        if ($from[0]->getName() !== '') {
            $sender['name'] = $from[0]->getName();
        }
        $message = [
            'subject' => (string) $original->getSubject(),
            'body' => ['contentType' => 'Text', 'content' => $text],
            'from' => ['emailAddress' => $sender],
        ];
        foreach (['toRecipients' => $original->getTo(), 'ccRecipients' => $original->getCc(), 'bccRecipients' => $original->getBcc(), 'replyTo' => $original->getReplyTo()] as $field => $addresses) {
            if ($addresses !== []) {
                $message[$field] = array_map(self::recipient(...), $addresses);
            }
        }

        // false, not "false": the mailbox keeps no copy of a code.
        return ['message' => $message, 'saveToSentItems' => false];
    }

    /** @return array{emailAddress: array{address: string, name?: string}} */
    private static function recipient(Address $address): array
    {
        $entry = ['address' => $address->getAddress()];
        if ($address->getName() !== '') {
            $entry['name'] = $address->getName();
        }

        return ['emailAddress' => $entry];
    }

    /** An access token for Graph: the cached one, or a new one from the metadata endpoint. */
    private function token(): string
    {
        $key = $this->cacheKey();
        try {
            $cached = Cache::get($key);
            if (is_string($cached)) {
                return Crypt::decryptString($cached);
            }
        } catch (DecryptException) {
            // Encrypted with another APP_KEY: ask again.
        } catch (Throwable $e) {
            Log::warning(self::LOG_PREFIX.' token cache not readable', ['exception' => $e::class]);
        }

        $response = $this->call('token', fn () => $this->http()
            ->withHeaders(['Metadata' => 'true'])
            // Never through a proxy, also not one named in the environment: '' turns curl's off.
            ->withOptions(['proxy' => ''])
            ->get(self::TOKEN_URL, [
                'api-version' => self::TOKEN_API_VERSION,
                'resource' => self::RESOURCE,
                'client_id' => $this->clientId,
            ]));

        $body = $response->status() === 200 ? $response->json() : null;
        $token = is_array($body) ? ($body['access_token'] ?? null) : null;
        $type = is_array($body) ? ($body['token_type'] ?? null) : null;
        // A string of seconds (the endpoint sends "3599"); a number is taken as well.
        $expiresIn = is_array($body) ? filter_var($body['expires_in'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) : false;
        if (! is_string($token) || preg_match('/^\S+$/', $token) !== 1 || ! is_string($type) || strcasecmp($type, 'Bearer') !== 0 || $expiresIn === false) {
            throw $this->failure('token', $response);
        }

        $seconds = $expiresIn - self::TOKEN_MARGIN;
        if ($seconds >= self::MIN_CACHE_SECONDS) {
            try {
                Cache::put($key, Crypt::encryptString($token), $seconds);
            } catch (Throwable $e) {
                // The mail still goes out; the next one asks again.
                Log::warning(self::LOG_PREFIX.' token not cached', ['exception' => $e::class]);
            }
        }

        return $token;
    }

    private function forgetToken(): void
    {
        try {
            Cache::forget($this->cacheKey());
        } catch (Throwable $e) {
            Log::warning(self::LOG_PREFIX.' token cache not cleared', ['exception' => $e::class]);
        }
    }

    /** Bound to the identity, keyed with APP_KEY. */
    private function cacheKey(): string
    {
        return 'mail-graph-token:'.hash_hmac('sha256', $this->clientId, (string) config('app.key'));
    }

    /** Laravel's HTTP client with the limits every request here has. */
    private function http(): PendingRequest
    {
        return Http::connectTimeout(self::CONNECT_TIMEOUT)
            ->timeout(self::TIMEOUT)
            ->withoutRedirecting()
            ->acceptJson();
    }

    /**
     * One request: its answer, or a failure without an answer (a timeout, no connection). The
     * client's own exception is not kept: its message names the URL and the transfer.
     *
     * @param  Closure(): Response  $request
     */
    private function call(string $stage, Closure $request): Response
    {
        try {
            return $request();
        } catch (Throwable) {
            throw $this->failure($stage, null);
        }
    }

    /**
     * Logs the failure at error level and returns the exception for it: the request, the HTTP
     * status and the error code of the answer, nothing else of it.
     */
    private function failure(string $stage, ?Response $response): TransportException
    {
        $status = $response?->status();
        $code = $response === null ? null : self::code($response);
        $retryAfter = $response === null ? false : filter_var($response->header('Retry-After'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 86400]]);

        $context = ['stage' => $stage, 'status' => $status, 'error' => $code, 'hint' => self::HINTS[self::kind($stage, $status)]];
        if (is_int($retryAfter)) {
            $context['retry_after'] = $retryAfter;
        }
        Log::error(self::LOG_PREFIX.' mail not sent', $context);

        return new TransportException(sprintf(
            'Microsoft Graph mail: the %s request failed (%s%s)',
            $stage,
            $status === null ? 'no answer' : 'HTTP '.$status,
            $code === null ? '' : ', '.$code,
        ));
    }

    /** A refusal before any request (no answer to report): logged like a failure. */
    private function refusal(string $why): TransportException
    {
        Log::error(self::LOG_PREFIX.' mail not sent', ['stage' => 'message', 'status' => null, 'error' => 'refused', 'hint' => $why]);

        return new TransportException('Microsoft Graph mail: refused: '.$why);
    }

    private static function kind(string $stage, ?int $status): string
    {
        return match (true) {
            $status === null => 'no answer',
            $status === 429 => 'throttled',
            $status >= 500 => 'unavailable',
            $stage === 'token' && $status === 400 => 'identity',
            $stage === 'token' && in_array($status, [404, 410], true) => 'updating',
            $stage === 'token' && in_array($status, [401, 403], true) => 'refused',
            $stage === 'send' && $status === 401 => 'token refused',
            $stage === 'send' && $status === 403 => 'permission',
            $stage === 'send' && $status === 404 => 'mailbox',
            default => 'unexpected',
        };
    }

    /**
     * The metadata endpoint's `error` or Graph's `error.code`, if it has a safe form. Never a
     * description or a message: they can name the identity, the tenant or a recipient.
     */
    private static function code(Response $response): ?string
    {
        $body = $response->json();
        $error = is_array($body) ? ($body['error'] ?? null) : null;
        $code = is_string($error) ? $error : (is_array($error) && is_string($error['code'] ?? null) ? $error['code'] : null);
        if ($code === null) {
            return null;
        }

        return preg_match(self::CODE, $code) === 1 ? $code : 'unknown';
    }

    /** The mailbox as a path segment: percent-encoded, with `@` kept (users/{userPrincipalName}). */
    private static function pathAddress(string $address): string
    {
        return str_replace('%40', '@', rawurlencode($address));
    }

    private static function text(mixed $value): string
    {
        return is_string($value) ? $value : '';
    }
}
