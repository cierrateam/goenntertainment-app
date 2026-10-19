<?php

namespace Tests\Feature;

use App\Support\TwoFactor;
use Illuminate\Http\Client\Request;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use RuntimeException;
use Symfony\Component\Mailer\Exception\TransportException;
use Tests\AppFeatureTestCase;

/**
 * Mails with a code (password reset, two-factor, a new e-mail address, a first password) never go
 * through the log transport, not even when MAIL_MAILER names it or a failover chain contains it:
 * the log would hold the code (F-09, F-04; App\Support\CodeMail). The mail is refused like a
 * failed one: the reset answers neutrally and keeps no code, the signed-in routes answer 503, and
 * the log names the exception class.
 *
 * The real mail manager runs here (no Mail::fake), so the transport that would send is the one
 * the configuration picks. With the graph mailer, Laravel's HTTP client is faked: no request
 * leaves the test.
 */
class CodeMailTest extends AppFeatureTestCase
{
    /** The graph mailer's sender mailbox. */
    private const GRAPH_SENDER = 'sender@example.invalid';

    /** @var list<array{level: string, text: string}> */
    private array $logged = [];

    protected function setUp(): void
    {
        parent::setUp();
        // The null channel keeps a leaked test code out of storage/logs if a test fails; every
        // log call still raises MessageLogged, the log transport's included.
        config(['logging.default' => 'null', 'mail.mailers.log.channel' => 'null']);
        Event::listen(MessageLogged::class, function (MessageLogged $event) {
            $this->logged[] = ['level' => $event->level, 'text' => $event->message.' '.json_encode($event->context)];
        });
    }

    /** No mail was written to the log (a mail in the log carries its headers). */
    private function assertNoMailInTheLog(): void
    {
        foreach ($this->logged as $record) {
            $this->assertStringNotContainsString('Subject:', $record['text'], 'a mail was written to the log');
        }
    }

    /** The refusal was logged as an error, by exception class. */
    private function assertRefusalLogged(string $prefix): void
    {
        $errors = array_filter($this->logged, fn (array $r) => $r['level'] === 'error' && str_contains($r['text'], $prefix));
        $this->assertCount(1, $errors, "no '{$prefix}' error was logged");
        $this->assertStringContainsString(json_encode(RuntimeException::class), (string) array_values($errors)[0]['text']);
    }

    public function test_a_reset_code_mail_goes_out_on_a_real_transport(): void
    {
        // The positive control: phpunit.xml's array mailer is not the log, so the code is sent.
        $user = $this->makeUser();

        $this->postJson('/api/forgot-password', ['email' => $user->email])->assertOk();

        $sent = app('mail.manager')->mailer('array')->getSymfonyTransport()->messages();
        $this->assertCount(1, $sent);
        $this->assertSame($user->email, $sent->first()->getEnvelope()->getRecipients()[0]->getAddress());
        $this->assertSame(1, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'reset')->count());
    }

    public function test_reset_code_mails_are_refused_on_the_log_mailer(): void
    {
        config(['mail.default' => 'log']);
        $user = $this->makeUser();

        $this->postJson('/api/forgot-password', ['email' => $user->email])
            ->assertOk()
            ->assertJsonPath('status', 'sent');

        $this->assertNoMailInTheLog();
        $this->assertRefusalLogged('[password-reset] code mail not sent');
        // A code nobody received is useless: it is gone, and a new request may mail at once.
        $this->assertSame(0, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'reset')->count());
    }

    public function test_two_factor_code_mails_are_refused_on_the_log_mailer(): void
    {
        config(['mail.default' => 'log']);
        $user = $this->makeUser(['two_factor_method' => TwoFactor::METHOD_EMAIL, 'two_factor_confirmed_at' => now()]);

        $this->withBearer($this->issueToken($user))
            ->postJson('/api/user/two-factor/code')
            ->assertStatus(503)
            ->assertJsonPath('message', TwoFactor::MSG_MAIL_FAILED);

        $this->assertNoMailInTheLog();
        $this->assertRefusalLogged('[two-factor] Code-Mail nicht versendet');
    }

    /**
     * The code that confirms a new e-mail address (F-04) goes to that address on a real
     * transport; the positive control of the refusal below.
     */
    public function test_an_e_mail_change_code_goes_out_on_a_real_transport(): void
    {
        $user = $this->makeUser();
        $new = 'moved-'.$user->username.'@example.invalid';

        $this->withBearer($this->issueToken($user))
            ->putJson('/api/user/email', ['email' => $new, 'current_password' => self::TEST_PASSWORD])
            ->assertOk();

        $sent = app('mail.manager')->mailer('array')->getSymfonyTransport()->messages();
        $this->assertCount(1, $sent);
        $this->assertSame($new, $sent->first()->getEnvelope()->getRecipients()[0]->getAddress());
        $this->assertSame(1, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'new_email')->count());
    }

    public function test_e_mail_change_code_mails_are_refused_on_the_log_mailer(): void
    {
        config(['mail.default' => 'log']);
        $user = $this->makeUser();

        $this->withBearer($this->issueToken($user))
            ->putJson('/api/user/email', ['email' => 'moved-'.$user->username.'@example.invalid', 'current_password' => self::TEST_PASSWORD])
            ->assertStatus(503)
            ->assertJsonPath('message', TwoFactor::MSG_MAIL_FAILED);

        $this->assertNoMailInTheLog();
        $this->assertRefusalLogged('[email-change] code mail not sent');
        // A code nobody received is useless, and the address stays as it was.
        $this->assertSame(0, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'new_email')->count());
        $this->assertSame($user->email, DB::table('users')->where('id', $user->id)->value('email'));
    }

    public function test_first_password_code_mails_are_refused_on_the_log_mailer(): void
    {
        config(['mail.default' => 'log']);
        $user = $this->makeUser(['password' => null]);

        $this->withBearer($this->issueToken($user))
            ->postJson('/api/user/password/code')
            ->assertStatus(503)
            ->assertJsonPath('message', TwoFactor::MSG_MAIL_FAILED);

        $this->assertNoMailInTheLog();
        $this->assertRefusalLogged('[first-password] code mail not sent');
        $this->assertSame(0, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'first_pw')->count());
    }

    public function test_a_failover_chain_with_the_log_mailer_is_refused_too(): void
    {
        // The array mailer would take the mail first; the chain is refused all the same, because
        // the log is one of its members.
        config(['mail.mailers.failover.mailers' => ['array', 'log'], 'mail.default' => 'failover']);
        $user = $this->makeUser(['two_factor_method' => TwoFactor::METHOD_EMAIL, 'two_factor_confirmed_at' => now()]);

        $this->withBearer($this->issueToken($user))
            ->postJson('/api/user/two-factor/code')
            ->assertStatus(503);

        $this->assertNoMailInTheLog();
        $this->assertRefusalLogged('[two-factor] Code-Mail nicht versendet');
        $this->assertCount(0, app('mail.manager')->mailer('array')->getSymfonyTransport()->messages());
    }

    /**
     * The graph mailer (App\Mail\GraphTransport) with a faked metadata endpoint and Graph: no
     * request leaves the test. Graph answers $status to sendMail.
     */
    private function useGraph(int $status = 202): void
    {
        config([
            'mail.default' => 'graph',
            'mail.mailers.graph' => ['transport' => 'graph', 'client_id' => '00000000-0000-4000-8000-00000000000b'],
            'mail.from.address' => self::GRAPH_SENDER,
        ]);
        Mail::forgetMailers();
        Http::preventStrayRequests();
        Http::fake([
            'http://169.254.169.254/*' => Http::response(['access_token' => 'fake-codemail-token-not-a-secret', 'expires_in' => '3599', 'token_type' => 'Bearer']),
            'https://graph.microsoft.com/*' => Http::response($status === 202 ? '' : ['error' => ['code' => 'ErrorAccessDenied', 'message' => 'refused']], $status),
        ]);
    }

    public function test_a_reset_code_mail_goes_out_through_microsoft_graph(): void
    {
        $this->useGraph();
        $user = $this->makeUser();

        $this->postJson('/api/forgot-password', ['email' => $user->email])->assertOk();

        Http::assertSent(fn (Request $request) => $request->url() === 'https://graph.microsoft.com/v1.0/users/'.self::GRAPH_SENDER.'/sendMail'
            && ($request->data()['message']['toRecipients'][0]['emailAddress']['address'] ?? null) === $user->email
            && preg_match('/(?<!\d)\d{6}(?!\d)/', (string) ($request->data()['message']['body']['content'] ?? '')) === 1
            && ($request->data()['saveToSentItems'] ?? null) === false);
        $this->assertSame(1, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'reset')->count());
        $this->assertNoMailInTheLog();
    }

    public function test_a_failover_chain_of_graph_and_the_log_mailer_is_refused(): void
    {
        $this->useGraph();
        config(['mail.mailers.failover.mailers' => ['graph', 'log'], 'mail.default' => 'failover']);
        Mail::forgetMailers();
        $user = $this->makeUser(['two_factor_method' => TwoFactor::METHOD_EMAIL, 'two_factor_confirmed_at' => now()]);

        $this->withBearer($this->issueToken($user))
            ->postJson('/api/user/two-factor/code')
            ->assertStatus(503);

        Http::assertNothingSent();
        $this->assertNoMailInTheLog();
        $this->assertRefusalLogged('[two-factor] Code-Mail nicht versendet');
    }

    public function test_a_refused_graph_mail_answers_neutrally_keeps_no_code_and_logs_graphs_code(): void
    {
        $this->useGraph(403);
        $user = $this->makeUser();

        $this->postJson('/api/forgot-password', ['email' => $user->email])
            ->assertOk()
            ->assertJsonPath('status', 'sent');

        $this->assertSame(0, DB::table('two_factor_challenges')->where('user_id', $user->id)->where('purpose', 'reset')->count());
        // The caller logs the exception class (F-38); the transport logs what Graph answered.
        $caller = array_values(array_filter($this->logged, fn (array $r) => $r['level'] === 'error' && str_contains($r['text'], '[password-reset] code mail not sent')));
        $this->assertCount(1, $caller);
        $this->assertStringContainsString(json_encode(TransportException::class), $caller[0]['text']);
        $graph = array_values(array_filter($this->logged, fn (array $r) => $r['level'] === 'error' && str_contains($r['text'], '[mail-graph] mail not sent')));
        $this->assertCount(1, $graph);
        foreach (['"stage":"send"', '"status":403', '"error":"ErrorAccessDenied"'] as $part) {
            $this->assertStringContainsString($part, $graph[0]['text']);
        }
        $this->assertStringNotContainsString($user->email, $graph[0]['text']);
    }
}
