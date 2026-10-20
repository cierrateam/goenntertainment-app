<?php

namespace Tests\Feature;

use App\Mail\GraphTransport;
use App\Mail\TwoFactorCode;
use GuzzleHttp\Promise\PromiseInterface;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Mailer\Envelope;
use Symfony\Component\Mailer\Exception\TransportException;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;
use Tests\TestCase;
use Throwable;

/**
 * The `graph` mailer (App\Mail\GraphTransport) against Laravel's faked HTTP client: no request
 * leaves the test (preventStrayRequests). The token comes from the server's metadata endpoint as
 * the managed identity MAIL_GRAPH_CLIENT_ID; the client ID, the token and every address here
 * are made up.
 *
 * The fake error answers carry the token, the code and the recipient in their descriptions on
 * purpose: whatever the transport copied from an answer would show up in the leak check that
 * every failure runs.
 */
class GraphTransportTest extends TestCase
{
    private const CLIENT = '00000000-0000-4000-8000-00000000000b';

    private const TOKEN = 'fake-graph-access-token-not-a-secret';

    private const MAILBOX = 'sender@example.invalid';

    private const RECIPIENT = 'person@example.invalid';

    private const CODE = '482915';

    private const METADATA = 'http://169.254.169.254/metadata/identity/oauth2/token';

    private const SEND_URL = 'https://graph.microsoft.com/v1.0/users/'.self::MAILBOX.'/sendMail';

    /** @var list<array{level: string, message: string, context: array<string, mixed>}> */
    private array $logged = [];

    /** @var list<array{url: string, options: array<string, mixed>}> */
    private array $requests = [];

    private string|false $ignoreArgs = false;

    protected function setUp(): void
    {
        parent::setUp();
        // Stack traces with their arguments, so the leak check sees what a log could print.
        $this->ignoreArgs = ini_set('zend.exception_ignore_args', '0');
        config([
            'logging.default' => 'null',
            'mail.default' => 'graph',
            'mail.from' => ['address' => self::MAILBOX, 'name' => 'GÖ4Fun'],
            'mail.mailers.graph' => ['transport' => 'graph', 'client_id' => self::CLIENT],
        ]);
        Mail::forgetMailers();
        Cache::flush();
        Http::preventStrayRequests();
        Event::listen(MessageLogged::class, function (MessageLogged $event) {
            $this->logged[] = ['level' => $event->level, 'message' => $event->message, 'context' => $event->context];
        });
    }

    protected function tearDown(): void
    {
        if ($this->ignoreArgs !== false) {
            ini_set('zend.exception_ignore_args', $this->ignoreArgs);
        }
        parent::tearDown();
    }

    private static function isTokenRequest(string $url): bool
    {
        return str_starts_with($url, self::METADATA.'?');
    }

    /**
     * The metadata endpoint answers $token, Graph answers $send (closures that return an answer);
     * every request is recorded with the options it was sent with.
     */
    private function fake(mixed $token, mixed $send = null): void
    {
        Http::fake(function (Request $request, array $options) use ($token, $send) {
            $this->requests[] = ['url' => $request->url(), 'options' => $options];

            return match (true) {
                self::isTokenRequest($request->url()) => value($token, $request),
                $request->url() === self::SEND_URL => value($send, $request),
                default => null,
            };
        });
    }

    /** The metadata endpoint's answer: every field a string, as Microsoft Learn shows it. */
    private static function tokenAnswer(int $expiresIn = 3599): PromiseInterface
    {
        return Factory::response([
            'access_token' => self::TOKEN,
            'refresh_token' => '',
            'expires_in' => (string) $expiresIn,
            'expires_on' => '1792500000',
            'not_before' => '1792496100',
            'resource' => 'https://graph.microsoft.com',
            'token_type' => 'Bearer',
        ]);
    }

    private static function accepted(): PromiseInterface
    {
        return Factory::response('', 202);
    }

    /** An error answer of the metadata endpoint (token) or Graph (send), with everything the transport must not copy. */
    private static function errorAnswer(string $stage, int $status, string $error, array $headers = []): PromiseInterface
    {
        $leaky = 'identity '.self::CLIENT.' token '.self::TOKEN.' to '.self::RECIPIENT.' code '.self::CODE;
        $body = $stage === 'token'
            ? ['error' => $error, 'error_description' => $leaky]
            : ['error' => ['code' => $error, 'message' => $leaky, 'innerError' => ['request-id' => '00000000-0000-4000-8000-0000000000c2']]];

        return Factory::response($body, $status, $headers);
    }

    /** One code mail through the configured mailer, as the app sends it (TwoFactorCode, text only). */
    private function sendCodeMail(): void
    {
        Mail::to(self::RECIPIENT)->send(new TwoFactorCode(self::CODE, 10));
    }

    /** One Symfony message straight to the graph transport, with an envelope of its own if given. */
    private function sendEmail(Email $email, ?Envelope $envelope = null): void
    {
        Mail::mailer('graph')->getSymfonyTransport()->send($email, $envelope);
    }

    private static function plainEmail(): Email
    {
        return (new Email)->from(new Address(self::MAILBOX, 'GÖ4Fun'))->to(self::RECIPIENT)->subject('Dein GÖ4Fun-Code')->text('Dein Code: '.self::CODE);
    }

    private function cacheKey(string $clientId = self::CLIENT): string
    {
        return 'mail-graph-token:'.hash_hmac('sha256', $clientId, (string) config('app.key'));
    }

    private function tokenRequests(): int
    {
        return count(array_filter($this->requests, fn (array $r) => self::isTokenRequest($r['url'])));
    }

    /** @return list<array{level: string, message: string, context: array<string, mixed>}> */
    private function graphLog(): array
    {
        return array_values(array_filter($this->logged, fn (array $r) => str_starts_with($r['message'], GraphTransport::LOG_PREFIX)));
    }

    /** No token, body, subject or recipient in any log line or in the exception. */
    private function assertNothingLeaked(?Throwable $thrown): void
    {
        $texts = array_map(fn (array $r) => $r['message'].' '.json_encode($r['context'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $this->logged);
        $traces = [];
        for ($e = $thrown; $e !== null; $e = $e->getPrevious()) {
            $texts[] = $e::class.': '.$e->getMessage();
            $traces[] = $e->getTraceAsString();
        }
        $this->assertNotSame([], $texts, 'nothing was logged or thrown, so nothing was checked');
        foreach ($texts as $text) {
            foreach ([self::TOKEN, self::CODE, self::RECIPIENT, 'Dein GÖ4Fun-Code', 'identity '.self::CLIENT] as $value) {
                $this->assertStringNotContainsString($value, $text);
            }
        }
        // A trace may name the recipient through the framework's own frames; never the token or the code.
        foreach ($traces as $trace) {
            foreach ([self::TOKEN, substr(self::TOKEN, 0, 12), self::CODE] as $value) {
                $this->assertStringNotContainsString($value, $trace);
            }
        }
    }

    public function test_the_token_comes_from_the_metadata_endpoint_as_the_managed_identity(): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());

        $this->sendCodeMail();

        Http::assertSent(function (Request $request) {
            if (! self::isTokenRequest($request->url())) {
                return false;
            }
            $this->assertSame('GET', $request->method());
            $url = parse_url($request->url());
            $this->assertSame(['http', '169.254.169.254', '/metadata/identity/oauth2/token'], [$url['scheme'], $url['host'], $url['path']], 'plain HTTP to exactly the metadata endpoint');
            $this->assertArrayNotHasKey('port', $url);
            parse_str($url['query'], $query);
            $this->assertSame(['api-version' => '2018-02-01', 'resource' => 'https://graph.microsoft.com', 'client_id' => self::CLIENT], $query);
            $this->assertSame(['true'], $request->header('Metadata'));
            $this->assertFalse($request->hasHeader('Authorization'), 'the token request carries an Authorization header');
            $this->assertFalse($request->hasHeader('X-Forwarded-For'), 'the metadata endpoint refuses forwarded requests');

            return true;
        });
    }

    public function test_send_mail_posts_json_as_the_mailbox_and_keeps_no_copy(): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());

        $this->sendEmail(self::plainEmail()
            ->addCc('copy@example.invalid')
            ->addBcc(new Address('hidden@example.invalid', 'Hidden'))
            ->replyTo('answers@example.invalid'));

        Http::assertSent(function (Request $request) {
            if ($request->url() !== self::SEND_URL) {
                return false;
            }
            $this->assertSame('POST', $request->method());
            $this->assertSame(['Bearer '.self::TOKEN], $request->header('Authorization'));
            $this->assertTrue($request->isJson(), 'sendMail is not JSON');
            $this->assertSame([
                'message' => [
                    'subject' => 'Dein GÖ4Fun-Code',
                    'body' => ['contentType' => 'Text', 'content' => 'Dein Code: '.self::CODE],
                    'from' => ['emailAddress' => ['address' => self::MAILBOX, 'name' => 'GÖ4Fun']],
                    'toRecipients' => [['emailAddress' => ['address' => self::RECIPIENT]]],
                    'ccRecipients' => [['emailAddress' => ['address' => 'copy@example.invalid']]],
                    'bccRecipients' => [['emailAddress' => ['address' => 'hidden@example.invalid', 'name' => 'Hidden']]],
                    'replyTo' => [['emailAddress' => ['address' => 'answers@example.invalid']]],
                ],
                'saveToSentItems' => false,
            ], $request->data());
            // The boolean false, never the string "false".
            $this->assertStringContainsString('"saveToSentItems":false', $request->body());

            return true;
        });
    }

    public function test_every_request_is_bounded_never_redirected_and_the_token_request_never_proxied(): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());

        $this->sendCodeMail();

        $this->assertCount(2, $this->requests);
        $this->assertTrue(self::isTokenRequest($this->requests[0]['url']));
        $this->assertSame(self::SEND_URL, $this->requests[1]['url']);
        foreach ($this->requests as $request) {
            $this->assertSame(GraphTransport::CONNECT_TIMEOUT, $request['options']['connect_timeout'] ?? null, $request['url']);
            $this->assertSame(GraphTransport::TIMEOUT, $request['options']['timeout'] ?? null, $request['url']);
            $this->assertFalse($request['options']['allow_redirects'] ?? true, $request['url'].' follows redirects');
        }
        // '' turns off curl's proxy, environment variables included (IMDS is not meant to be proxied).
        $this->assertSame('', $this->requests[0]['options']['proxy'] ?? null, 'the token request may go through a proxy');
        // Inside the app's own 15-second limit, also with a new token (src/lib/api.ts).
        $this->assertLessThanOrEqual(10, 2 * GraphTransport::TIMEOUT);
    }

    public function test_one_token_serves_two_mails_and_is_cached_encrypted(): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());

        $this->sendCodeMail();
        $this->sendCodeMail();

        $this->assertSame(1, $this->tokenRequests());
        $this->assertSame(2, count($this->requests) - 1);
        $stored = Cache::get($this->cacheKey());
        $this->assertIsString($stored, 'the token is not in the cache');
        $this->assertStringNotContainsString(self::TOKEN, $stored, 'the cached token is not encrypted');
        $this->assertSame(self::TOKEN, Crypt::decryptString($stored));
    }

    public function test_the_token_is_renewed_five_minutes_before_it_expires(): void
    {
        $this->fake(fn () => self::tokenAnswer(3599), fn () => self::accepted());

        $this->sendCodeMail();
        $this->travel(3599 - GraphTransport::TOKEN_MARGIN - 1)->seconds();
        $this->sendCodeMail();
        $this->assertSame(1, $this->tokenRequests(), 'the token was renewed too early');

        $this->travel(2)->seconds();
        $this->sendCodeMail();
        $this->assertSame(2, $this->tokenRequests(), 'an expiring token was still used');
    }

    public function test_a_token_with_little_time_left_is_used_once_and_not_cached(): void
    {
        $this->fake(fn () => self::tokenAnswer(GraphTransport::TOKEN_MARGIN + GraphTransport::MIN_CACHE_SECONDS - 1), fn () => self::accepted());

        $this->sendCodeMail();
        $this->sendCodeMail();

        $this->assertSame(2, $this->tokenRequests());
        $this->assertNull(Cache::get($this->cacheKey()));
    }

    public function test_another_identity_takes_another_token(): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());
        $this->sendCodeMail();

        config(['mail.mailers.graph.client_id' => '00000000-0000-4000-8000-00000000000c']);
        Mail::forgetMailers();
        $this->sendCodeMail();

        $this->assertSame(2, $this->tokenRequests());
        $this->assertIsString(Cache::get($this->cacheKey('00000000-0000-4000-8000-00000000000c')));
    }

    public function test_a_token_cached_under_another_app_key_is_replaced(): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());
        Cache::put($this->cacheKey(), 'eyJpdiI6ImZha2UifQ==', 600);

        $this->sendCodeMail();

        $this->assertSame(1, $this->tokenRequests());
        $this->assertSame(self::TOKEN, Crypt::decryptString(Cache::get($this->cacheKey())));
    }

    /**
     * Every way a mail can fail at the metadata endpoint or at Graph: [its answer, Graph's
     * answer, the words the exception names, the error code logged, whether a cached token is
     * dropped, Retry-After].
     *
     * @return array<string, array{0: mixed, 1: mixed, 2: list<string>, 3: string|null, 4: bool, 5: int|null}>
     */
    public static function failures(): array
    {
        // A connection that times out; its message names the identity and the token, so a copied
        // message would show in the leak check.
        $timeout = fn (Request $request) => Factory::failedConnection('cURL error 28: Operation timed out after 5001 milliseconds for identity '.self::CLIENT.' token '.self::TOKEN)($request);
        $token = fn () => self::tokenAnswer();

        return [
            'token 400, no such identity' => [fn () => self::errorAnswer('token', 400, 'invalid_request'), null, ['token request', 'HTTP 400', 'invalid_request'], 'invalid_request', false, null],
            'token 404, updating' => [fn () => self::errorAnswer('token', 404, 'not_found'), null, ['token request', 'HTTP 404', 'not_found'], 'not_found', false, null],
            'token 410, updating' => [fn () => Factory::response('', 410), null, ['token request', 'HTTP 410'], null, false, null],
            'token 429, throttled' => [fn () => self::errorAnswer('token', 429, 'too_many_requests', ['Retry-After' => '2']), null, ['token request', 'HTTP 429', 'too_many_requests'], 'too_many_requests', false, 2],
            'token 500' => [fn () => self::errorAnswer('token', 500, 'unknown'), null, ['token request', 'HTTP 500', 'unknown'], 'unknown', false, null],
            'token 200 without a token' => [fn () => Factory::response(['token_type' => 'Bearer', 'expires_in' => '3599']), null, ['token request', 'HTTP 200'], null, false, null],
            'token 307 to another host' => [fn () => Factory::response('', 307, ['Location' => 'https://collector.example.invalid/token']), null, ['token request', 'HTTP 307'], null, false, null],
            'token timeout' => [$timeout, null, ['token request', 'no answer'], null, false, null],
            'send 401, a refused token' => [$token, fn () => self::errorAnswer('send', 401, 'InvalidAuthenticationToken'), ['send request', 'HTTP 401', 'InvalidAuthenticationToken'], 'InvalidAuthenticationToken', true, null],
            'send 403, no permission for the mailbox' => [$token, fn () => self::errorAnswer('send', 403, 'ErrorAccessDenied'), ['send request', 'HTTP 403', 'ErrorAccessDenied'], 'ErrorAccessDenied', true, null],
            'send 404, an unknown mailbox' => [$token, fn () => self::errorAnswer('send', 404, 'ErrorInvalidUser'), ['send request', 'HTTP 404', 'ErrorInvalidUser'], 'ErrorInvalidUser', false, null],
            'send 429, throttled' => [$token, fn () => self::errorAnswer('send', 429, 'ApplicationThrottled', ['Retry-After' => '30']), ['send request', 'HTTP 429', 'ApplicationThrottled'], 'ApplicationThrottled', false, 30],
            'send 500' => [$token, fn () => self::errorAnswer('send', 500, 'InternalServerError'), ['send request', 'HTTP 500', 'InternalServerError'], 'InternalServerError', false, null],
            'send 503' => [$token, fn () => self::errorAnswer('send', 503, 'ServiceNotAvailable', ['Retry-After' => '10']), ['send request', 'HTTP 503', 'ServiceNotAvailable'], 'ServiceNotAvailable', false, 10],
            'send 200 instead of 202' => [$token, fn () => Factory::response(''), ['send request', 'HTTP 200'], null, false, null],
            'send timeout' => [$token, $timeout, ['send request', 'no answer'], null, false, null],
        ];
    }

    #[DataProvider('failures')]
    public function test_a_failure_names_the_request_status_and_code_and_leaks_nothing(mixed $token, mixed $send, array $words, ?string $code, bool $drops, ?int $retryAfter): void
    {
        $this->fake($token, $send);
        // A token from an earlier mail, so a send failure shows whether it is dropped.
        if ($send !== null) {
            Cache::put($this->cacheKey(), Crypt::encryptString(self::TOKEN), 600);
        }

        $thrown = null;
        try {
            $this->sendCodeMail();
        } catch (Throwable $e) {
            $thrown = $e;
        }

        $this->assertInstanceOf(TransportException::class, $thrown, 'a failure must be a TransportException (AccountController catches that interface)');
        $this->assertNull($thrown->getPrevious(), 'the HTTP client\'s exception (URL, transfer details) is kept');
        foreach ($words as $word) {
            $this->assertStringContainsString($word, $thrown->getMessage());
        }
        $errors = array_values(array_filter($this->graphLog(), fn (array $r) => $r['level'] === 'error'));
        $this->assertCount(1, $errors, 'exactly one error line per failed mail');
        $this->assertSame($send === null ? 'token' : 'send', $errors[0]['context']['stage']);
        $this->assertSame($code, $errors[0]['context']['error']);
        $this->assertNotEmpty($errors[0]['context']['hint']);
        $this->assertSame($retryAfter, $errors[0]['context']['retry_after'] ?? null);
        if ($send !== null) {
            $this->assertSame($drops, Cache::get($this->cacheKey()) === null, $drops ? 'the refused token is still cached' : 'the cached token was dropped');
        }
        // One request per stage reached: a redirect is never followed, a failed token sends nothing.
        $this->assertSame(1, count($this->requests), 'more than one request: '.implode(', ', array_column($this->requests, 'url')));
        $this->assertSame($send === null, self::isTokenRequest($this->requests[0]['url']));
        $this->assertNothingLeaked($thrown);
    }

    /** @return array<string, array{0: callable(Email): Email, 1: string}> */
    public static function refusals(): array
    {
        return [
            'an HTML part' => [fn (Email $e) => $e->html('<p>Dein Code</p>'), 'plain-text'],
            'an attachment' => [fn (Email $e) => $e->attach('fake attachment', 'note.txt', 'text/plain'), 'plain-text'],
            'another sender' => [fn (Email $e) => $e->from('someone-else@example.invalid'), 'MAIL_FROM_ADDRESS'],
        ];
    }

    #[DataProvider('refusals')]
    public function test_what_the_app_never_sends_is_refused_before_any_request(callable $change, string $word): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());

        $thrown = null;
        try {
            $this->sendEmail($change(self::plainEmail()));
        } catch (Throwable $e) {
            $thrown = $e;
        }

        $this->assertInstanceOf(TransportException::class, $thrown);
        $this->assertStringContainsString($word, $thrown->getMessage());
        Http::assertNothingSent();
        $this->assertCount(1, array_filter($this->graphLog(), fn (array $r) => $r['level'] === 'error'));
        $this->assertNothingLeaked($thrown);
    }

    public function test_a_message_without_recipients_never_reaches_graph(): void
    {
        // Symfony refuses it before any transport runs; even with an envelope of its own the
        // message itself must name a recipient.
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());

        $thrown = null;
        try {
            $this->sendEmail((new Email)->from(self::MAILBOX)->subject('x')->text('y'), new Envelope(new Address(self::MAILBOX), [new Address(self::RECIPIENT)]));
        } catch (Throwable $e) {
            $thrown = $e;
        }

        $this->assertNotNull($thrown, 'a message without recipients was sent');
        Http::assertNothingSent();
    }

    /** @return array<string, array{0: array<string, string>, 1: string|null, 2: string}> */
    public static function settings(): array
    {
        return [
            'no client ID' => [['client_id' => ''], null, 'MAIL_GRAPH_CLIENT_ID'],
            'a client ID that is no GUID' => [['client_id' => 'not-a-guid'], null, 'MAIL_GRAPH_CLIENT_ID'],
            'a client ID with a query in it' => [['client_id' => self::CLIENT.'&resource=x'], null, 'MAIL_GRAPH_CLIENT_ID'],
            'a mailbox that is no address' => [[], 'not-an-address', 'MAIL_FROM_ADDRESS'],
        ];
    }

    #[DataProvider('settings')]
    public function test_a_missing_or_malformed_setting_is_named_and_nothing_is_sent(array $mailer, ?string $mailbox, string $name): void
    {
        $this->fake(fn () => self::tokenAnswer(), fn () => self::accepted());
        config(['mail.mailers.graph' => array_merge(config('mail.mailers.graph'), $mailer)]);
        if ($mailbox !== null) {
            config(['mail.from.address' => $mailbox]);
        }
        Mail::forgetMailers();

        $thrown = null;
        try {
            $this->sendCodeMail();
        } catch (Throwable $e) {
            $thrown = $e;
        }

        $this->assertInstanceOf(InvalidArgumentException::class, $thrown);
        $this->assertStringContainsString($name, $thrown->getMessage());
        Http::assertNothingSent();
        $logged = $this->graphLog();
        $this->assertCount(1, $logged);
        $this->assertSame('error', $logged[0]['level']);
        $this->assertContains($name, $logged[0]['context']['settings']);
        $this->assertNothingLeaked($thrown);
    }

    public function test_the_transport_is_named_graph(): void
    {
        $this->assertSame('graph', (string) GraphTransport::fromConfig(config('mail.mailers.graph'), self::MAILBOX));
        $this->assertSame([], $this->graphLog());
    }
}
