<?php

namespace App\Support;

use Illuminate\Mail\MailManager;
use Illuminate\Mail\Transport\LogTransport;
use Illuminate\Support\Facades\Mail;
use Illuminate\Contracts\Mail\Mailable;
use RuntimeException;
use Symfony\Component\Mailer\Transport\TransportInterface;

/**
 * Sends mails that carry a code (two-factor codes, password reset codes), never through the log
 * transport: whoever can read the log could sign in or reset the password with the code (F-09).
 *
 * config/mail.php already defaults to SMTP and has no failover to the log mailer, but MAIL_MAILER
 * (or MAIL_URL) could still name it. So the transport that would really be used is looked at
 * before each code mail: the log transport itself, or a failover or round-robin chain that
 * contains it (Symfony names a chain "failover(smtp://… log)"), and the mail is refused with an
 * exception. The callers treat that like any other failed mail; nothing with the code is logged.
 * The `graph` transport (App\Mail\GraphTransport, named "graph") goes through like SMTP; a chain
 * that holds it next to the log transport is refused all the same.
 * A faked mailer in tests (Mail::fake) is not a MailManager and is not checked.
 */
final class CodeMail
{
    public const REFUSED = 'Refusing to send a code mail through the log mailer.';

    public static function send(string $to, Mailable $mail): void
    {
        $manager = Mail::getFacadeRoot();
        if ($manager instanceof MailManager && self::writesToLog($manager->mailer()->getSymfonyTransport())) {
            throw new RuntimeException(self::REFUSED);
        }

        Mail::to($to)->send($mail);
    }

    /** Is $transport the log transport, or a chain with the log transport in it? */
    public static function writesToLog(TransportInterface $transport): bool
    {
        if ($transport instanceof LogTransport) {
            return true;
        }

        // A chain's name lists its members, each by its own name; the log transport's is "log".
        return preg_match('/(?:^|[\s(])log(?:$|[\s)])/', (string) $transport) === 1;
    }
}
