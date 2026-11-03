<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\Media;
use App\Support\Uploads;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Tests\AppFeatureTestCase;

/**
 * Ban and timeout evidence is private (as in the former Node backend, server/test/private-media
 * tests): it is stored outside every public folder, its address is the admin route, and only an
 * admin gets the file - with nosniff, a sandbox policy and no cache.
 */
class EvidencePrivacyTest extends AppFeatureTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Storage::fake('private');
    }

    private static function png(): string
    {
        $image = imagecreatetruecolor(24, 24);
        imagefilledrectangle($image, 0, 0, 23, 23, (int) imagecolorallocate($image, 10, 120, 200));
        ob_start();
        imagepng($image);
        imagedestroy($image);

        return (string) ob_get_clean();
    }

    /** An admin bans $target with an evidence image; returns [admin token, stored path]. */
    private function banWithEvidence(User $target): array
    {
        $admin = $this->makeUser(['is_admin' => true]);
        $token = $this->issueToken($admin);

        $this->withBearer($token)->post("/api/admin/users/{$target->id}/ban", [
            'reason' => 'Fixture reason for the evidence test',
            'evidence' => UploadedFile::fake()->createWithContent('evidence.png', self::png()),
        ], ['Accept' => 'application/json'])->assertOk();

        $path = (string) DB::table('ban_evidence')->where('user_id', $target->id)->value('image_path');

        return [$token, $path];
    }

    public function test_evidence_is_stored_on_the_private_disk_only(): void
    {
        [, $path] = $this->banWithEvidence($this->makeUser());

        $this->assertMatchesRegularExpression('#^evidence/[0-9a-f]{40}\.png$#', $path);
        Storage::disk('private')->assertExists($path);
        Storage::disk('public')->assertMissing($path);
    }

    public function test_the_evidence_address_is_the_admin_route_never_storage(): void
    {
        $target = $this->makeUser();
        [$token, $path] = $this->banWithEvidence($target);

        $item = collect($this->withBearer($token)->getJson('/api/admin/evidence')->assertOk()->json('data'))
            ->firstWhere('user.id', $target->id);
        $this->assertNotNull($item);
        $this->assertStringEndsWith('/api/admin/evidence-files/'.basename($path), (string) $item['image_url']);
        $this->assertStringNotContainsString('/storage/', (string) $item['image_url']);
        $this->assertStringNotContainsString('/storage/', (string) Media::url('evidence/'.str_repeat('ab', 20).'.jpg'));
    }

    public function test_only_an_admin_gets_the_file_with_the_stored_file_headers(): void
    {
        $target = $this->makeUser();
        [$token, $path] = $this->banWithEvidence($target);
        $url = '/api/admin/evidence-files/'.basename($path);

        $response = $this->withBearer($token)->get($url)->assertOk();
        $this->assertSame('image/png', $response->headers->get('Content-Type'));
        $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'));
        $this->assertStringContainsString('sandbox', (string) $response->headers->get('Content-Security-Policy'));
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->assertSame(Storage::disk('private')->get($path), $response->getContent());

        $this->app['auth']->forgetGuards();
        $other = $this->makeUser();
        $this->withBearer($this->issueToken($other))->getJson($url)->assertForbidden();
        $this->app['auth']->forgetGuards();
        $this->flushHeaders();
        $this->getJson($url)->assertUnauthorized();
    }

    /**
     * Behind Cloudflare, which caches .jpg, .png and .webp by their extension, this one header is
     * what keeps ban evidence out of its cache (and out of every other one): Cloudflare does not
     * cache an answer marked private or no-store (deploy/README.md, Cloudflare and the load
     * balancer). Exactly these two directives, no max-age, no public. Symfony writes them sorted.
     */
    public function test_the_evidence_answer_may_be_kept_by_no_cache(): void
    {
        $target = $this->makeUser();
        [$token, $path] = $this->banWithEvidence($target);

        $response = $this->withBearer($token)->get('/api/admin/evidence-files/'.basename($path))->assertOk();

        $value = (string) $response->headers->get('Cache-Control');
        $this->assertSame('no-store, private', $value);
        $directives = array_map(trim(...), explode(',', strtolower($value)));
        sort($directives);
        $this->assertSame(['no-store', 'private'], $directives);
        $this->assertFalse($response->headers->has('Expires'), 'an Expires header would let a cache keep the image');
    }

    public function test_names_outside_the_stored_pattern_are_not_found(): void
    {
        $admin = $this->makeUser(['is_admin' => true]);
        $token = $this->issueToken($admin);

        foreach (['..%2F.env', 'evidence.png', str_repeat('g', 40).'.png', str_repeat('ab', 20).'.php'] as $name) {
            $this->withBearer($token)->getJson('/api/admin/evidence-files/'.$name)->assertNotFound();
        }
        // The right shape, but no such file.
        $this->withBearer($token)->getJson('/api/admin/evidence-files/'.str_repeat('cd', 20).'.png')->assertNotFound();
    }

    /**
     * On the real disk configuration (not a fake): owner and group may read, nobody else. The
     * deploy's backup reads the volume through that group (deploy/docker-compose.yml, group_add);
     * Laravel's default for private files (0600) would make every backup run fail.
     */
    public function test_evidence_files_are_readable_for_the_owner_and_its_group_only(): void
    {
        $root = sys_get_temp_dir().'/evidence-modes-'.bin2hex(random_bytes(6));
        config(['filesystems.disks.private.root' => $root]);
        Storage::forgetDisk('private');
        try {
            $path = Uploads::store(UploadedFile::fake()->createWithContent('evidence.png', self::png()), 'evidence', 'evidence');

            $this->assertSame('0640', sprintf('%04o', fileperms("{$root}/{$path}") & 0777));
            $this->assertSame('0750', sprintf('%04o', fileperms("{$root}/evidence") & 0777));
        } finally {
            File::deleteDirectory($root);
        }
    }
}
