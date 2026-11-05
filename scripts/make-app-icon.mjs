/**
 * Erzeugt App-Symbol und Profilbild mit Gönnis Gesicht – ausführen mit
 * `node scripts/make-app-icon.mjs` (Windows, rendert mit Edge headless).
 *
 * ## Vorbild: Duolingo
 *
 * Das Duolingo-Symbol ist kein Bild einer Figur, sondern ein Gesicht, das das
 * ganze Quadrat füllt. Davon übernommen sind die Verhältnisse, nicht die Eule:
 *
 *  - Der Kopf ist so groß, dass er links und rechts aus dem Bild läuft. Oben
 *    bleibt nur ein Streifen Hintergrund, aus dem die Silhouette ragt – bei Duo
 *    die Federohren, bei Gönni die Antenne mit Kugel (sein Erkennungszeichen).
 *  - Die Augen sitzen auf halber Höhe, weit außen (Mitte bei ~27 % und ~73 %),
 *    und sind zusammen gut halb so breit wie das Bild.
 *  - Das Mittelstück zwischen den Augen (bei Duo der Schnabel) ist hier Gönnis
 *    offener Mund mit Zunge, etwas tiefer als die Augenmitte.
 *  - Flach, zwei Töne derselben Farbe: Kopf im Marken-Pink, Hintergrund eine
 *    Stufe dunkler. Keine Verläufe, keine Schatten – so bleibt es auch mit 29 px
 *    auf dem Homescreen lesbar.
 *
 * Gönni behält dabei seine eigenen Züge (dunkle Augen mit Glanz oben rechts,
 * Bäckchen, Antenne) – mit Duos weißen Augäpfeln und Schnabel wäre es eine
 * Kopie und kein Symbol für GÖ4Fun.
 *
 * ## Splash-Screen
 *
 * Auf dem Startbildschirm steht Gönni als ganze Figur (Zeichnung aus
 * mascot.tsx, winkend) auf demselben dunkleren Pink wie das Symbol – Tippen aufs
 * Symbol und Start sehen so aus wie ein Bild. Android 12+ zeigt vom Splash-Bild
 * nur einen Kreis von 192 dp; die Figur liegt darum ganz in einem Kreis um die
 * Bildmitte (app.json: `imageWidth` 200).
 *
 * ## Ausgabe
 *
 * `assets/brand/goenni-icon/`: die SVG-Quelle und alle PNGs. Für die App
 * (app.json) werden sie nach `assets/images/` kopiert, wenn `--install` dabei ist.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const Jimp = require('jimp-compact');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'assets', 'brand', 'goenni-icon');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/** Marken-Farben (src/constants/theme.ts, src/components/mascot.tsx). */
const C = {
  head: '#fe2c55',
  bg: '#d90f47',
  face: '#4c0519',
  cheek: '#ff7f9d',
  tongue: '#ff7a98',
  feet: '#c41d44',
};

/**
 * Alles in einer 1024er-Box (App-Store-Größe). Kopf = Kreisbogen oben, darunter
 * gefüllt bis weit unter den Rand, damit auch ein herausgezoomter Ausschnitt
 * (Android-Vordergrund) keine Kante zeigt.
 */
const G = {
  domeTop: 286,
  domeRx: 760,
  domeRy: 520,
  eyeY: 556,
  eyeDx: 240, // Abstand der Augenmitte von der Bildmitte
  eyeRx: 128,
  eyeRy: 156,
  mouthTop: 678,
  mouthW: 236,
  mouthH: 138,
  antennaTop: 150,
  antennaW: 54,
  ballR: 72,
};

const CX = 512;
const domeCy = G.domeTop + G.domeRy;

function head(fill) {
  return (
    `<ellipse cx="${CX}" cy="${domeCy}" rx="${G.domeRx}" ry="${G.domeRy}" fill="${fill}"/>` +
    `<rect x="${CX - G.domeRx}" y="${domeCy}" width="${G.domeRx * 2}" height="1200" fill="${fill}"/>`
  );
}

function antenna(fill, shine = true) {
  const ballY = G.antennaTop;
  return (
    `<path d="M${CX} ${G.domeTop + 40}V${ballY}" stroke="${fill}" stroke-width="${G.antennaW}" stroke-linecap="round"/>` +
    `<circle cx="${CX}" cy="${ballY}" r="${G.ballR}" fill="${fill}"/>` +
    (shine ? `<circle cx="${CX - 24}" cy="${ballY - 24}" r="${G.ballR * 0.3}" fill="#fff" fill-opacity=".75"/>` : '')
  );
}

/** Augen: dunkles Oval, Glanzpunkt oben rechts wie in mascot.tsx (cx+0.35rx, cy-0.4ry). */
function eyes(fill, shineFill = '#fff') {
  return [-1, 1]
    .map((side) => {
      const cx = CX + side * G.eyeDx;
      return (
        `<ellipse cx="${cx}" cy="${G.eyeY}" rx="${G.eyeRx}" ry="${G.eyeRy}" fill="${fill}"/>` +
        `<circle cx="${cx + G.eyeRx * 0.34}" cy="${G.eyeY - G.eyeRy * 0.38}" r="${G.eyeRx * 0.34}" fill="${shineFill}"/>` +
        `<circle cx="${cx - G.eyeRx * 0.36}" cy="${G.eyeY + G.eyeRy * 0.42}" r="${G.eyeRx * 0.1}" fill="${shineFill}"/>`
      );
    })
    .join('');
}

/** Offener Mund (wie „cheer" in mascot.tsx): oben gerade, unten rund, Zunge unten. */
function mouthPath() {
  const w = G.mouthW, h = G.mouthH, x = CX - w / 2, y = G.mouthTop, r = 26;
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}C${x + w} ${y + h * 0.72} ${CX + w * 0.28} ${y + h} ${CX} ${y + h}C${CX - w * 0.28} ${y + h} ${x} ${y + h * 0.72} ${x} ${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}

function mouth(fill, tongue) {
  const id = 'mouthClip';
  const t = tongue
    ? `<clipPath id="${id}"><path d="${mouthPath()}"/></clipPath>` +
      `<ellipse clip-path="url(#${id})" cx="${CX}" cy="${G.mouthTop + G.mouthH + 6}" rx="${G.mouthW * 0.3}" ry="${G.mouthH * 0.42}" fill="${tongue}"/>`
    : '';
  return `<path d="${mouthPath()}" fill="${fill}"/>` + t;
}

function cheeks(fill) {
  return [-1, 1]
    .map((side) => `<ellipse cx="${CX + side * (G.eyeDx + G.eyeRx * 0.9)}" cy="${G.eyeY + G.eyeRy * 1.22}" rx="${G.eyeRx * 0.64}" ry="${G.eyeRx * 0.38}" fill="${fill}"/>`)
    .join('');
}

/**
 * Das ganze Gesicht. `view` = Ausschnitt in der 1024er-Box (für Android und das
 * runde Profilbild wird herausgezoomt), `bg` = Hintergrund oder null (durchsichtig).
 */
function iconSvg({ view = [0, 0, 1024, 1024], bg = C.bg, headFill = C.head, size = 1024 } = {}) {
  const [x, y, w, h] = view;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${x} ${y} ${w} ${h}">
  ${bg ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>` : ''}
  ${antenna(headFill)}
  ${head(headFill)}
  ${cheeks(C.cheek)}
  ${eyes(C.face)}
  ${mouth(C.face, C.tongue)}
</svg>`;
}

/**
 * Android 13+ färbt das Symbol selbst ein und nimmt dafür nur die Deckkraft:
 * Kopf und Antenne voll, Augen und Mund ausgestanzt, Glanzpunkte bleiben.
 */
function monochromeSvg({ view, size = 1024 }) {
  const [x, y, w, h] = view;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${x} ${y} ${w} ${h}">
  <defs><mask id="cut" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>
    ${eyes('#000', '#fff')}
    ${mouth('#000', null)}
  </mask></defs>
  <g mask="url(#cut)">${antenna('#fff', false)}${head('#fff')}</g>
</svg>`;
}

/**
 * Gönni ganz, winkend – Maße aus der 92er-Box von mascot.tsx (Körper, Antenne,
 * Ärmchen, Füße), flach gefärbt wie das Symbol. Durchsichtig: die Farbe dahinter
 * setzt app.json (`backgroundColor`).
 */
function splashSvg() {
  const body = 'M46 19c15.5 0 25 11.6 25 27.5 0 16.4-9.8 27.5-25 27.5S21 62.9 21 46.5C21 30.6 30.5 19 46 19Z';
  const s = 10.4;
  // Figurmitte (46, 41) auf Bildmitte – so liegt alles im Kreis, den Android zeigt.
  const t = `translate(${512 - 46 * s} ${512 - 41 * s}) scale(${s})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <g transform="${t}">
    <ellipse cx="46" cy="79.5" rx="17" ry="2.6" fill="#7a0322" fill-opacity=".28"/>
    <ellipse cx="37" cy="73.6" rx="6.4" ry="3.4" fill="${C.feet}"/>
    <ellipse cx="55" cy="73.6" rx="6.4" ry="3.4" fill="${C.feet}"/>
    <path d="M46 20V11" stroke="${C.head}" stroke-width="3.4" stroke-linecap="round"/>
    <circle cx="46" cy="8.4" r="4.2" fill="${C.head}"/>
    <circle cx="44.6" cy="7" r="1.2" fill="#fff" fill-opacity=".75"/>
    <path d="M23 52l-8.5 6.5M69 44l9.5-10.5" stroke="${C.head}" stroke-width="5.2" stroke-linecap="round"/>
    <path d="${body}" fill="${C.head}"/>
    <ellipse cx="36.5" cy="29" rx="7.5" ry="4.2" transform="rotate(-24 36.5 29)" fill="#fff" fill-opacity=".28"/>
    <ellipse cx="28.5" cy="52" rx="4.2" ry="2.6" fill="${C.cheek}"/>
    <ellipse cx="63.5" cy="52" rx="4.2" ry="2.6" fill="${C.cheek}"/>
    <ellipse cx="34" cy="44" rx="5.2" ry="6" fill="${C.face}"/>
    <ellipse cx="58" cy="44" rx="5.2" ry="6" fill="${C.face}"/>
    <circle cx="35.8" cy="41.6" r="1.8" fill="#fff"/>
    <circle cx="59.8" cy="41.6" r="1.8" fill="#fff"/>
    <path d="M35 55c0 7 4.9 11.4 11 11.4S57 62 57 55z" fill="${C.face}"/>
    <path d="M40.2 61.8c1.6-2.2 9.9-2.2 11.6 0-1.6 2.4-3.6 3.4-5.8 3.4s-4.2-1-5.8-3.4z" fill="${C.tongue}"/>
  </g>
</svg>`;
}

/** Rendert eine SVG-Datei mit Edge zu PNG (durchsichtiger Grund, wo nichts gezeichnet ist). */
function render(svg, file, size) {
  const svgFile = file.replace(/\.png$/, '.render.svg');
  writeFileSync(svgFile, svg);
  execFileSync(
    EDGE,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${file}`,
      pathToFileURL(svgFile).href,
    ],
    { stdio: 'ignore' },
  );
  rmSync(svgFile);
}

/** Ohne Alpha speichern – der App Store lehnt Symbole mit Transparenz ab. */
function flatten(file) {
  const png = PNG.sync.read(readFileSync(file));
  writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
}

async function resize(from, to, size, opaque) {
  const img = await Jimp.read(from);
  img.resize(size, size, Jimp.RESIZE_BICUBIC);
  await img.writeAsync(to);
  if (opaque) flatten(to);
}

/** Ausschnitt um die Bildmitte, `zoom` < 1 zoomt heraus. */
function zoomed(zoom) {
  const w = 1024 / zoom;
  const o = (1024 - w) / 2;
  return [o, o, w, w];
}

mkdirSync(OUT, { recursive: true });
const out = (name) => path.join(OUT, name);

// Quelle zum Weiterbearbeiten.
writeFileSync(out('goenni-icon.svg'), iconSvg());

// iOS / App Store: volles Quadrat, Ecken rundet das System selbst.
render(iconSvg(), out('icon-1024.png'), 1024);
flatten(out('icon-1024.png'));

// Profilbild (Instagram, TikTok …): wird rund beschnitten – leicht herausgezoomt,
// damit die Antennenkugel sicher im Kreis liegt.
render(iconSvg({ view: zoomed(0.94), size: 1080 }), out('profilbild-1080.png'), 1080);
flatten(out('profilbild-1080.png'));

// Android (adaptiv): sichtbar sind nur die inneren 72 von 108 dp. Damit dort
// dasselbe Bild steht wie auf iOS, zoomt der Vordergrund auf 72/108 heraus.
const android = zoomed(72 / 108);
render(iconSvg({ view: android, bg: null }), out('android-icon-foreground.png'), 1024);
render(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${C.bg}"/></svg>`, out('android-icon-background.png'), 1024);
flatten(out('android-icon-background.png'));
render(monochromeSvg({ view: android }), out('android-icon-monochrome.png'), 1024);

// Splash-Screen (durchsichtig, Hintergrund = C.bg in app.json)
render(splashSvg(), out('splash-icon.png'), 1024);

// Web
await resize(out('icon-1024.png'), out('favicon.png'), 64, true);

if (process.argv.includes('--install')) {
  const images = path.join(ROOT, 'assets', 'images');
  copyFileSync(out('icon-1024.png'), path.join(images, 'icon.png'));
  for (const name of ['android-icon-foreground.png', 'android-icon-background.png', 'android-icon-monochrome.png', 'splash-icon.png', 'favicon.png']) {
    copyFileSync(out(name), path.join(images, name));
  }
  console.log('in assets/images/ übernommen');
}

console.log('ok', OUT);
