<?php

namespace App\Providers;

use App\Mail\GraphTransport;
use App\Support\RateLimitKeys;
use App\Support\RateLimitRules;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Laravel\Sanctum\PersonalAccessToken;
use Laravel\Sanctum\Sanctum;

class AppServiceProvider extends ServiceProvider
{
    /** The answer to a request over a limit (Laravel's own is English; the app shows it as is). */
    public const MSG_TOO_MANY = 'Zu viele Versuche – bitte warte kurz und probier es dann noch mal.';

    /** The answer when the group chat's limiter refuses a message. */
    public const MSG_CHAT_TOO_FAST = 'Kurz durchatmen – das waren viele Nachrichten auf einmal.';

    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        $this->configureRateLimiting();

        // The `graph` mailer (config/mail.php): Microsoft Graph as the server's managed identity.
        Mail::extend('graph', static fn (array $config) => GraphTransport::fromConfig($config, config('mail.from.address')));

        /*
         * A token is valid only with an expiry date that has not passed (F-20). Sanctum alone
         * accepts a token without `expires_at` (it then checks only its age against
         * sanctum.expiration); tokens from before expiry existed have none and end here.
         * App\Support\Sessions issues every token with one. The former Node backend's requireAuth
         * applies the whole rule too, the age included (server/src/auth.js, TOKEN_IS_VALID_SQL).
         */
        Sanctum::authenticateAccessTokensUsing(
            static fn (PersonalAccessToken $token, bool $isValid): bool => $isValid && $token->expires_at !== null,
        );
    }

    /**
     * Bremsen fuer alles, wo jemand raten koennte - Passwoerter und Codes.
     *
     * ## Warum mehrere Schluessel je Bremse
     *
     * Einer je Ziel (E-Mail-Adresse, Vorgang, Konto) und einer je IP. Nur je IP
     * liesse sich mit wechselnden Adressen umgehen und traefe zugleich ganze
     * Schulen hinter einer IP; nur je Ziel liesse eine IP beliebig viele
     * Konten durchprobieren. Zusammen bremst es beides, ohne Unbeteiligte
     * auszusperren.
     *
     * The per-account scope counts one account across every client address (F-01/F-19 review:
     * rotating addresses must not reset the count). Numbers and scopes: config/ratelimits.php;
     * keys: App\Support\RateLimitKeys; the counters live in the database cache store.
     *
     * ## Warum eine eigene Antwort
     *
     * Laravels Vorgabe ist „Too Many Attempts." - englisch, und die App zeigt
     * `message` woertlich an. Die Kopfzeilen (Retry-After, X-RateLimit-*)
     * bleiben, damit die App auf Wunsch einen Countdown zeigen kann.
     *
     * Die Zahlen sind grosszuegig fuer Menschen (niemand tippt zehnmal pro
     * Minute ein Passwort) und knapp fuer Skripte. Die eigentliche Obergrenze
     * fuer Codes ist ohnehin absolut: fuenf Fehlversuche je Vorgang (siehe
     * App\Support\TwoFactor).
     */
    private function configureRateLimiting(): void
    {
        // Every rule parsed now, not on the first request to its route: a malformed override
        // stops the boot (and the api container's start) instead of answering 500 later.
        RateLimitRules::assertValid(config('ratelimits'));

        $tooMany = static fn (Request $request, array $headers) => response()->json(
            ['message' => self::MSG_TOO_MANY],
            429,
            $headers,
        );

        $limits = static fn (string $limiter, array $keys) => RateLimitRules::limits($limiter, $keys, $tooMany);

        RateLimiter::for('register', static fn (Request $request) => $limits('register', [
            'ip' => RateLimitKeys::ip($request),
            'account' => RateLimitKeys::account($request->input('email')),
        ]));

        RateLimiter::for('login', static function (Request $request) use ($limits) {
            $account = RateLimitKeys::account($request->input('email'));
            $ip = RateLimitKeys::ip($request);

            return $limits('login', ['account_ip' => $account.'|'.$ip, 'ip' => $ip, 'account' => $account]);
        });

        RateLimiter::for('password-forgot', static fn (Request $request) => $limits('password-forgot', [
            'ip' => RateLimitKeys::ip($request),
            'account' => RateLimitKeys::account($request->input('email')),
        ]));

        RateLimiter::for('password-reset', static fn (Request $request) => $limits('password-reset', [
            'ip' => RateLimitKeys::ip($request),
            'account' => RateLimitKeys::account($request->input('email')),
        ]));

        RateLimiter::for('two-factor', static fn (Request $request) => $limits('two-factor', [
            'challenge' => hash('sha256', is_scalar($request->input('challenge')) ? (string) $request->input('challenge') : ''),
            'ip' => RateLimitKeys::ip($request),
            'account' => RateLimitKeys::challengeAccount($request->input('challenge')),
        ]));

        // Der Abstand von 60 s je Vorgang steht in TwoFactor::claimResend; das
        // hier faengt ab, wer viele Vorgaenge zugleich anstoesst.
        RateLimiter::for('two-factor-resend', static fn (Request $request) => $limits('two-factor-resend', [
            'ip' => RateLimitKeys::ip($request),
            'account' => RateLimitKeys::challengeAccount($request->input('challenge')),
        ]));

        // Einrichten/Ausschalten/Codes: angemeldet, also je Konto.
        RateLimiter::for('two-factor-setup', static fn (Request $request) => $limits('two-factor-setup', [
            'user' => RateLimitKeys::user($request),
        ]));

        // Passwort aendern, E-Mail-Adresse aendern und Konto loeschen: Alle pruefen
        // das Passwort, und ein gestohlener Token soll es nicht in Ruhe
        // durchprobieren koennen. The second steps of an e-mail change (the code from the new
        // address) and of a first password (its code mail) share the budget: one for all five.
        RateLimiter::for('account-sensitive', static fn (Request $request) => $limits('account-sensitive', [
            'user' => RateLimitKeys::user($request),
        ]));

        // PATCH /user: name, username and interests (no password check; a write with the word filter).
        RateLimiter::for('profile', static fn (Request $request) => $limits('profile', [
            'user' => RateLimitKeys::user($request),
        ]));

        // Gutscheincodes und Einladungscodes: Raten soll aussichtslos bleiben.
        RateLimiter::for('voucher-redeem', static fn (Request $request) => $limits('voucher-redeem', [
            'user' => RateLimitKeys::user($request),
            'ip' => RateLimitKeys::ip($request),
        ]));

        // Kaufen, Buchen, Abo, Stornieren und alles, was Credits bewegt: Ein Doppeltipp soll
        // nicht zweimal abbuchen - dafuer sorgt die App; das hier faengt Skripte ab.
        RateLimiter::for('payments', static fn (Request $request) => $limits('payments', [
            'user' => RateLimitKeys::user($request),
        ]));

        // Check-ins und Einloesen am Aufkleber: Ein Stempel gibt es ohnehin nur einmal am Tag je Partner.
        RateLimiter::for('checkin', static fn (Request $request) => $limits('checkin', [
            'user' => RateLimitKeys::user($request),
        ]));

        // POST /user/avatar: every upload is decoded and encoded again (App\Support\Uploads).
        RateLimiter::for('avatar', static fn (Request $request) => $limits('avatar', [
            'user' => RateLimitKeys::user($request),
        ]));

        // Chat: zehn Nachrichten in zehn Sekunden - wie die Bremse im alten Backend - and the chat
        // write class on top of it (config/ratelimits.php), with the chat's own answer.
        $chatTooFast = static fn (Request $request, array $headers) => response()->json(
            ['message' => self::MSG_CHAT_TOO_FAST],
            429,
            $headers,
        );
        RateLimiter::for('chat-send', static fn (Request $request) => RateLimitRules::limits('chat-send', [
            'user' => RateLimitKeys::user($request),
            'ip' => RateLimitKeys::ip($request),
        ], $chatTooFast));

        // Every other write route takes one of these classes (config/ratelimits.php names what
        // each is for): per account and per client address.
        foreach (['write-content', 'write-state', 'write-report', 'write-block', 'write-admin'] as $class) {
            RateLimiter::for($class, static fn (Request $request) => $limits($class, [
                'user' => RateLimitKeys::user($request),
                'ip' => RateLimitKeys::ip($request),
            ]));
        }

        // Lesen (config/ratelimits.php): angemeldet je Konto, die zwei Routen ohne Token je Adresse.
        foreach (['read', 'read-admin', 'admin-export'] as $class) {
            RateLimiter::for($class, static fn (Request $request) => $limits($class, [
                'user' => RateLimitKeys::user($request),
            ]));
        }
        RateLimiter::for('read-public', static fn (Request $request) => $limits('read-public', [
            'ip' => RateLimitKeys::ip($request),
        ]));
    }
}
