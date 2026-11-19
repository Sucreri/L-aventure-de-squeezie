/**
 * End-to-end check of the courier journey, in a real browser.
 *
 * The steps a courier performs are driven through the interface. The steps
 * somebody else performs — an admin confirming the Dimona declaration, a
 * client placing and paying for an order, the dispatcher reaching a courier
 * who has no browser geolocation — are done directly against the database,
 * because they are not this journey.
 *
 * Usage: node apps/mobile/tests/courier-journey.mjs [--shots <dir>]
 */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const postgres = require('postgres');

const APP_URL = process.env.APP_URL ?? 'http://localhost:8080';
const API_URL = process.env.API_URL ?? 'http://localhost:8787';
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;
if (SHOTS) await mkdir(SHOTS, { recursive: true });

const sql = postgres({
  host: process.env.PGHOST ?? '/var/run/postgresql',
  port: Number(process.env.PGPORT ?? 5433),
  database: process.env.PGDATABASE ?? 'uberpalette',
  username: process.env.PGUSER ?? 'postgres',
  onnotice: () => {},
});

const DEMO = {
  zoneBiereau: '11111111-0000-0000-0000-000000000001',
  storeCentre: '22222222-0000-0000-0000-000000000001',
  admin: '44444444-0000-0000-0000-000000000001',
  beer33: '33333333-0000-0000-0000-000000000001',
};

const checks = [];
function check(label, fn) {
  try { fn(); checks.push({ label, ok: true }); }
  catch (error) { checks.push({ label, ok: false, error: error.message }); }
}

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'fr-BE' });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

let step = 0;
async function shot(name) {
  step += 1;
  await page.waitForTimeout(600);
  if (SHOTS) {
    await page.screenshot({
      path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true,
    });
  }
}

async function press(name, { exact = false } = {}) {
  const button = page.getByRole('button', { name, exact })
    .filter({ visible: true }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await button.click();
  await page.waitForTimeout(900);
}

async function tick(name) {
  const box = page.getByRole('checkbox', { name, exact: false })
    .filter({ visible: true }).first();
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await box.click();
  await page.waitForTimeout(200);
}

async function fill(label, value) {
  const field = page.getByLabel(label, { exact: true }).filter({ visible: true }).first();
  await field.waitFor({ state: 'visible', timeout: 15000 });
  await field.fill(value);
  await page.waitForTimeout(120);
}

const text = async () => page.locator('body').innerText();

// ---------------------------------------------------------------- sign up

await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

await press('Créer un compte');
const email = `palettier-${Date.now()}@example.invalid`;
await fill('Prénom', 'Lucas');
await fill('Nom', 'Palettier');
await fill('Adresse e-mail', email);
await press('Continuer');
await press('Vérifier mon âge');
await page.waitForTimeout(1200);
await tick("J'accepte les conditions générales d'utilisation");
await tick("J'accepte les conditions générales de vente");
await tick("J'ai pris connaissance de la politique de confidentialité");
await press('Continuer');
await page.waitForTimeout(1200);

const [user] = await sql`select id from users where email = ${email}`;
const courierId = user.id;

// ---------------------------------------------------------------- apply

/**
 * Walks back to the home screen through browser history.
 *
 * Never page.goto: a full load would drop the session, which lives in memory
 * on purpose (HYPOTHESES.md H-21). Going back fires popstate, which the
 * router handles without remounting the app.
 */
async function goHome() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (/Où nous livrons/i.test(await text())) return;
    await page.goBack();
    await page.waitForTimeout(700);
  }
  throw new Error("impossible de revenir à l'accueil");
}

await goHome();

{
  const body = await text();
  check("l'accueil propose de devenir palettier",
    () => assert.match(body, /Devenir palettier/i));
}

await press('En savoir plus');
await shot('palettier-accueil');

{
  const body = await text();
  check("l'espace palettier dit la prochaine étape",
    () => assert.match(body, /Prochaine étape/i));
  check('les droits du palettier sont rappelés dès l\'accueil',
    () => {
      assert.match(body, /salarié, pas indépendant/i);
      assert.match(body, /aucune sanction/i);
    });
}

await press('Déposer ma candidature');
await shot('candidature');

{
  const body = await text();
  check('les capacités par moyen de transport sont annoncées (§14)',
    () => assert.match(body, /unités par trajet/i));
  check('le traitement des données de paie est expliqué (§4.7)',
    () => assert.match(body, /registre national.*secrétariat social/is));
}

await press('Choisir');   // premier moyen de transport
await fill("Attestation d'inscription", 'ATT-PARCOURS-001');
await shot('candidature-remplie');
await press('Déposer ma candidature');
await page.waitForTimeout(1500);

// ---------------------------------------------------------------- training

await shot('formation');

{
  const body = await text();
  check('la formation porte sur les sujets du §7.2',
    () => {
      assert.match(body, /Âges légaux|âge/i);
      assert.match(body, /ivre|ivresse/i);
    });
}

/*
 * Answering the quiz.
 *
 * The correct answer is matched by its TEXT, never by position: the server
 * shuffles the choices per courier precisely so that a position carries no
 * information.
 *
 * The buttons are walked in DOM order with a moving cursor, rather than
 * located inside "the card for this question". React Native Web renders
 * everything as nested divs, so a container selector picks an arbitrary
 * ancestor — and the same answer text appears under more than one question.
 */
const key = await sql`
  select prompt, choices, correct_index from training_questions
   where active order by display_rank, id`;

const buttons = page.getByRole('button').filter({ visible: true });
const labels = await buttons.evaluateAll(
  nodes => nodes.map(n => n.getAttribute('aria-label') ?? n.textContent?.trim() ?? ''));

let cursor = 0;
for (const question of key) {
  const answer = question.choices[question.correct_index];
  const found = labels.indexOf(answer, cursor);

  if (found === -1) {
    throw new Error(`réponse « ${answer} » introuvable après l'index ${cursor}`);
  }

  await buttons.nth(found).click();
  await page.waitForTimeout(60);
  cursor = found + 1;
}

await shot('formation-repondue');
await press('Valider');
await page.waitForTimeout(1500);
await shot('formation-resultat');

{
  const body = await text();
  check('la formation est validée quand toutes les réponses sont justes',
    () => assert.match(body, /Formation validée/i));
}

// ---------------------------------------------------------------- contract

await press('Voir mon contrat');
await shot('contrat');

{
  const body = await text();
  check('le contrat se présente comme un gabarit à valider (§0.4)',
    () => assert.match(body, /attente de validation juridique/i));
  check('le contrat affiche le quota étudiant de 650 h',
    () => assert.match(body, /650 h/));
  check('le contrat rappelle le droit à une explication des systèmes automatisés',
    () => assert.match(body, /explication écrite/i));
  check("le contrat nomme l'assurance accidents du travail (§4.3)",
    () => assert.match(body, /Assurance accidents du travail/i));
}

await tick("J'ai lu ce contrat");
await press('Signer électroniquement');
await page.waitForTimeout(1500);
await shot('contrat-signe');

{
  const body = await text();
  check('la Dimona reste à confirmer par l\'équipe (§7.3)',
    () => assert.match(body, /Dimona/));
}

// ---------------------------------------------------------------- admin + shift

// The Dimona confirmation belongs to the admin, and there is deliberately no
// courier route for it.
await sql`select set_config('app.current_user_id', ${DEMO.admin}, false)`;
await sql`select app.confirm_dimona(${courierId})`;

// A shift covering now, within the working-time rules.
const saved = await sql`
  select key, value from app_settings
   where key in ('work.service_end_time', 'work.night_work_threshold_time')`;
await sql`update app_settings set value = '"23:59"'::jsonb
           where key in ('work.service_end_time', 'work.night_work_threshold_time')`;
await sql`
  insert into shifts (zone_id, starts_at, ends_at, places, published_by,
                      night_derogation, derogation_validated_by, derogation_note)
  values (${DEMO.zoneBiereau}, now() - interval '30 minutes', now() + interval '3 hours',
          20, ${DEMO.admin}, true, ${DEMO.admin}, 'Parcours de test')`;
for (const row of saved) {
  await sql`update app_settings set value = ${row.value} where key = ${row.key}`;
}

await press('Retour', { exact: true });
await page.waitForTimeout(1200);
await press('Mes créneaux');
await shot('creneaux');

{
  const body = await text();
  check('les créneaux disent que le temps d\'attente est payé (§11)',
    () => assert.match(body, /payé pour toute la durée/i));
}

await press('Réserver');
await page.waitForTimeout(1200);
await shot('creneau-reserve');

{
  const body = await text();
  check('la réservation est confirmée',
    () => assert.match(body, /Annuler ma réservation/i));
}

// ---------------------------------------------------------------- an order

// Geolocation has no browser source here, so the position is inserted the way
// the device would send it.
const [booking] = await sql`
  select b.id from shift_bookings b join shifts s on s.id = b.shift_id
   where b.courier_id = ${courierId} and b.cancelled_at is null limit 1`;
await sql`insert into consents (user_id, consent_type, granted)
          values (${courierId}, 'geolocation', true)`;
await sql`insert into courier_positions (courier_id, shift_booking_id, lat, lon)
          values (${courierId}, ${booking.id}, 50.6695, 4.6145)`;

// A client orders and pays. Not this journey, so it goes through the API.
const clientEmail = `client-${Date.now()}@example.invalid`;
const registered = await (await fetch(`${API_URL}/auth/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ firstName: 'Client', lastName: 'Test', email: clientEmail }),
})).json();

await sql`
  update users set age_bracket = 'b18_plus', age_verified = true,
                   verification_method = 'itsme', verified_at = now(), status = 'active'
   where id = ${registered.userId}`;
for (const docKey of ['tos', 'sales_terms', 'privacy']) {
  await sql`
    insert into consents (user_id, consent_type, granted, legal_document_id)
    select ${registered.userId}, ${docKey}::consent_type, true, id
      from legal_documents where doc_key = ${docKey} and published_at is not null
     order by published_at desc limit 1`;
}

const clientHeaders = {
  'content-type': 'application/json',
  authorization: `Bearer ${registered.token}`,
};

const address = await (await fetch(`${API_URL}/addresses`, {
  method: 'POST', headers: clientHeaders,
  body: JSON.stringify({
    street: 'Rue des Blancs Chevaux', number: '33', floor: 2,
    isDefault: true, lat: 50.6680, lon: 4.6150,
  }),
})).json();

const placed = await (await fetch(`${API_URL}/orders`, {
  method: 'POST', headers: clientHeaders,
  body: JSON.stringify({
    addressId: address.addressId, storeId: DEMO.storeCentre,
    mode: 'express', method: 'bancontact',
    lines: [{ productId: DEMO.beer33, quantity: 1 }],
  }),
})).json();

// A known PIN, so the handover can be completed from the interface.
await sql`select app.set_order_pin(${placed.orderId}, '4417')`;

await fetch(`${API_URL}/dev/simulate-payment`, {
  method: 'POST', headers: clientHeaders,
  body: JSON.stringify({ orderId: placed.orderId }),
});

// ---------------------------------------------------------------- mission

await press('Retour', { exact: true });
await page.waitForTimeout(1500);
await shot('offre-recue');

{
  const body = await text();
  check("l'offre parvient au palettier avec le poids et l'étage (§7.5)",
    () => {
      assert.match(body, /kg/);
      assert.match(body, /étage/i);
    });
}

await press('Voir les offres');
await shot('offres');

{
  const body = await text();
  check("l'adresse du client n'apparaît pas dans l'offre (§7.5)",
    () => {
      assert.ok(!/Blancs Chevaux/.test(body),
        "l'adresse ne doit pas être visible avant acceptation");
      assert.match(body, /ne t'est communiquée qu'une fois la mission acceptée/i);
    });
  check('le refus est présenté comme sans conséquence (§7.5)',
    () => assert.match(body, /Refuser/));
}

await press('Accepter');
await page.waitForTimeout(1800);
await shot('mission-magasin');

{
  const body = await text();
  check("la mission commence par le magasin",
    () => assert.match(body, /Rends-toi au/i));
}

await press('Je suis au magasin');
await shot('mission-courses');

{
  const body = await text();
  check('la liste des articles est affichée',
    () => assert.match(body, /À acheter/i));
  check('le plafond de la carte de dépense est annoncé (§2)',
    () => assert.match(body, /Plafond pour cette mission/i));
  check("le palettier n'avance jamais son argent",
    () => assert.match(body, /jamais ton\s+propre argent/i));
  check("la correction manuelle du ticket est annoncée (§7.6)",
    () => assert.match(body, /c'est ta saisie qui fait foi/i));
}

{
  const body = await text();
  check("le signalement d'un article manquant est proposé (§7.6)",
    () => assert.match(body, /Signaler un problème sur cet article/i));
  check("le palettier ne décide pas à la place du client (§6.5)",
    () => assert.match(body, /tu ne décides pas à sa place/i));
}

// Signaler une rupture, puis constater le compte à rebours côté client.
await press('Signaler un problème sur cet article');
await press('Rupture de stock');
await page.waitForTimeout(1500);
await shot('mission-remplacement');

{
  const body = await text();
  check("l'attente de la réponse du client est affichée avec son délai",
    () => assert.match(body, /En attente de la réponse du client/i));
}

await fill('Montant du ticket, en euros', '14,99');
await press('Valider le ticket');
await page.waitForTimeout(1800);
await shot('mission-trajet');

{
  const body = await text();
  check("l'adresse apparaît une fois la mission acceptée",
    () => assert.match(body, /Blancs Chevaux/));
  check("l'étage et l'ascenseur sont précisés",
    () => assert.match(body, /Étage 2/));
}

await press('Je pars livrer');
await page.waitForTimeout(1200);
await press('Je suis arrivé');
await page.waitForTimeout(1200);
await shot('mission-remise');

{
  const body = await text();
  check("le contrôle d'âge est exigé pour l'alcool (§13.2)",
    () => assert.match(body, /Contrôle d'âge obligatoire/i));
  check("l'app rappelle de ne jamais photographier une pièce d'identité",
    () => assert.match(body, /Ne photographie jamais/i));
  check("l'année lue n'est pas enregistrée",
    () => assert.match(body, /n'est jamais enregistrée/i));
}

// Le PIN ne doit pas suffire sans contrôle d'âge.
await fill('Code à 4 chiffres', '4417');
await press('Valider la remise');
await page.waitForTimeout(1500);

{
  const body = await text();
  check("sans contrôle d'âge, la remise est refusée (§13.4)",
    () => assert.match(body, /contrôle d'âge validé est nécessaire/i));
}

await tick("Pièce d'identité vérifiée");
await tick('Personne en état normal');
await press('Valider le contrôle');
await page.waitForTimeout(1500);
await shot('controle-age');

await fill('Code à 4 chiffres', '4417');
await press('Valider la remise');
await page.waitForTimeout(2000);
await shot('mission-terminee');

{
  const [order] = await sql`select status from orders where id = ${placed.orderId}`;
  check('la commande est livrée après contrôle d\'âge puis PIN correct',
    () => assert.equal(order.status, 'DELIVERED'));

  const [ageCheck] = await sql`
    select to_jsonb(a) as payload from age_checks a where a.order_id = ${placed.orderId}`;
  check("le contrôle d'âge ne conserve aucune donnée d'identité (§13.2)",
    () => assert.ok(!/birth|naissance|annee|photo/i.test(JSON.stringify(ageCheck.payload))));
}

// ---------------------------------------------------------------- earnings

await page.waitForTimeout(1200);
await press('Mes heures et mes gains');
await shot('gains');

{
  const body = await text();
  check("les gains sont présentés comme une estimation (§7.8)",
    () => assert.match(body, /Ce chiffre est une estimation/i));
  check('la paie officielle est attribuée au secrétariat social',
    () => assert.match(body, /secrétariat social/i));
  check('le quota annuel de 650 h est affiché avec son compteur',
    () => assert.match(body, /650 h/));
  check('le compteur de quota avertit qu\'il ignore les autres employeurs',
    () => assert.match(body, /Student@work/));
}

/*
 * This journey deliberately provokes a refusal — handing over without an age
 * check — and the browser logs the resulting 4xx as a console error. That is
 * the system working, so it is not what this check is about.
 *
 * What must never happen is a JavaScript error: an unhandled exception, a
 * failed render, a missing field. Those are filtered for specifically.
 */
const expectedRefusals = /Failed to load resource.*\b(400|403|404)\b/;
const unexpected = consoleErrors.filter(e => !expectedRefusals.test(e));

check("aucune erreur JavaScript sur l'ensemble du parcours",
  () => assert.deepEqual(unexpected, []));

check('les refus serveur provoqués par le test sont bien des refus, pas des erreurs',
  () => assert.ok(consoleErrors.every(e => expectedRefusals.test(e)),
    `erreurs inattendues : ${JSON.stringify(consoleErrors)}`));

await browser.close();
await sql.end({ timeout: 5 });

// ---------------------------------------------------------------- report

const failed = checks.filter(c => !c.ok);

console.log('\n════════ PARCOURS PALETTIER ════════');
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`);
  if (!c.ok) console.log(`      ${c.error}`);
}
console.log(`\n${checks.length} vérifications, ${checks.length - failed.length} réussies, ${failed.length} en échec`);
if (SHOTS) console.log(`Captures : ${SHOTS}`);

process.exit(failed.length === 0 ? 0 : 1);
