<?php

namespace Tests\Unit;

use App\Support\RateLimitKeys;
use Illuminate\Http\Request;
use PHPUnit\Framework\TestCase;

/**
 * The address the rate limits count (App\Support\RateLimitKeys::ip). Behind Cloudflare the
 * visitor's own address arrives (CF-Connecting-IP, forwarded by Caddy), IPv6 included: an IPv6
 * subscriber usually gets a whole /64, so its addresses share one counter, or it could step
 * around every per-address rule by changing the last 64 bits.
 *
 * Plain PHPUnit: the key needs only the request.
 */
class RateLimitKeysTest extends TestCase
{
    private static function keyFor(string $address): string
    {
        return RateLimitKeys::ip(Request::create('/api/login', 'POST', server: ['REMOTE_ADDR' => $address]));
    }

    public function test_an_ipv4_address_is_its_own_key(): void
    {
        $this->assertSame('203.0.113.7', self::keyFor('203.0.113.7'));
        $this->assertNotSame(self::keyFor('203.0.113.7'), self::keyFor('203.0.113.8'));
    }

    public function test_ipv6_addresses_share_one_key_per_64(): void
    {
        $key = self::keyFor('2001:db8:1:2::1');

        $this->assertSame('v6:20010db800010002', $key);
        $this->assertSame($key, self::keyFor('2001:db8:1:2:ffff:ffff:ffff:ffff'), 'another address of the same /64');
        $this->assertSame($key, self::keyFor('2001:0db8:0001:0002:0000:0000:0000:0007'), 'another spelling of the same /64');
        $this->assertNotSame($key, self::keyFor('2001:db8:1:3::1'), 'the next /64');
    }

    public function test_no_address_is_counted_as_unknown(): void
    {
        $this->assertSame('unknown', self::keyFor(''));
    }
}
