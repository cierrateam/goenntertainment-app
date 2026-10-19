<?php

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Mail never falls back to the log transport: mails carry 2FA and reset codes, and a code must
 * never land in a log. Development mail goes to the local mail catcher instead.
 *
 * Plain PHPUnit: config/mail.php is read as a file; env() reads the process environment live.
 */
class MailConfigTest extends TestCase
{
    private static function apiPath(string $file): string
    {
        return dirname(__DIR__, 2).'/'.$file;
    }

    /** config/mail.php with MAIL_MAILER removed from the environment, restored afterwards. */
    private static function mailConfigWithoutMailer(): array
    {
        $saved = [$_ENV['MAIL_MAILER'] ?? null, $_SERVER['MAIL_MAILER'] ?? null, getenv('MAIL_MAILER')];
        unset($_ENV['MAIL_MAILER'], $_SERVER['MAIL_MAILER']);
        putenv('MAIL_MAILER');
        try {
            return require self::apiPath('config/mail.php');
        } finally {
            if ($saved[0] !== null) {
                $_ENV['MAIL_MAILER'] = $saved[0];
            }
            if ($saved[1] !== null) {
                $_SERVER['MAIL_MAILER'] = $saved[1];
            }
            if ($saved[2] !== false) {
                putenv('MAIL_MAILER='.$saved[2]);
            }
        }
    }

    /**
     * config/mail.php with these variables in the environment (null: unset), each restored
     * afterwards.
     *
     * @param  array<string, string|null>  $variables
     */
    private static function mailConfigWith(array $variables): array
    {
        $saved = [];
        foreach ($variables as $name => $value) {
            $saved[$name] = [$_ENV[$name] ?? null, $_SERVER[$name] ?? null, getenv($name)];
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
            if ($value !== null) {
                $_ENV[$name] = $_SERVER[$name] = $value;
                putenv("{$name}={$value}");
            }
        }
        try {
            return require self::apiPath('config/mail.php');
        } finally {
            foreach ($saved as $name => [$env, $server, $process]) {
                unset($_ENV[$name], $_SERVER[$name]);
                putenv($name);
                if ($env !== null) {
                    $_ENV[$name] = $env;
                }
                if ($server !== null) {
                    $_SERVER[$name] = $server;
                }
                if ($process !== false) {
                    putenv("{$name}={$process}");
                }
            }
        }
    }

    /**
     * The graph mailer (App\Mail\GraphTransport) signs in as the server's managed identity: its
     * client ID is the one setting, without a default, and there is no secret to configure.
     */
    public function test_the_graph_mailer_reads_only_the_managed_identity_without_a_default(): void
    {
        $unset = self::mailConfigWith(['MAIL_GRAPH_CLIENT_ID' => null]);
        $this->assertSame(['transport' => 'graph', 'client_id' => null], $unset['mailers']['graph']);

        $set = self::mailConfigWith(['MAIL_GRAPH_CLIENT_ID' => '00000000-0000-4000-8000-00000000000b']);
        $this->assertSame(['transport' => 'graph', 'client_id' => '00000000-0000-4000-8000-00000000000b'], $set['mailers']['graph']);
    }

    public function test_default_mailer_is_smtp_when_nothing_is_configured(): void
    {
        $this->assertSame('smtp', self::mailConfigWithoutMailer()['default']);
    }

    public function test_no_mailer_chain_falls_back_to_log(): void
    {
        $chains = array_filter(
            self::mailConfigWithoutMailer()['mailers'],
            fn (array $mailer) => isset($mailer['mailers']),
        );
        $this->assertNotEmpty($chains, 'no failover or round-robin mailer found - the config changed?');

        foreach ($chains as $name => $mailer) {
            $this->assertNotContains('log', $mailer['mailers'], "mailer '{$name}' falls back to the log");
        }
    }

    public function test_env_example_sends_development_mail_to_the_local_catcher(): void
    {
        $values = [];
        foreach (file(self::apiPath('.env.example'), FILE_IGNORE_NEW_LINES) as $line) {
            if (preg_match('/^([A-Z0-9_]+)=(.*)$/', trim($line), $m) === 1) {
                $this->assertArrayNotHasKey($m[1], $values, "{$m[1]} is set twice in .env.example");
                $values[$m[1]] = trim($m[2], '"');
            }
        }

        $this->assertSame('smtp', $values['MAIL_MAILER'] ?? null);
        $this->assertSame('127.0.0.1', $values['MAIL_HOST'] ?? null);
        $this->assertSame('1025', $values['MAIL_PORT'] ?? null);
    }
}
