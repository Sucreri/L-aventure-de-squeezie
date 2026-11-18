/**
 * End-to-end check of the client journey, in a real browser.
 *
 * Runs against the built web bundle and the real API, which talks to the real
 * database. Nothing is mocked except the payment and age-verification
 * providers, which do not exist yet as contracts.
 *
 * It asserts rather than merely screenshotting: the screenshots are a
 * by-product for human review, the assertions are what fails the build.
 *
 * Usage: node apps/mobile/tests/journey.mjs [--shots <dir>]
 */

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const APP_URL = process.env.APP_URL ?? 'http://localhost:8080';
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;

if (SHOTS) await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'fr-BE' });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

const checks = [];
function check(label, fn) {
  try { fn(); checks.push({ label, ok: true }); }
  catch (error) { checks.push({ label, ok: false, error: error.message }); }
}

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

async function press(name) {
  const button = page.getByRole('button', { name, exact: false })
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

// ---------------------------------------------------------------- home

await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await shot('accueil');

{
  const body = await text();
  check("l'accueil nomme l'Opérateur avant toute commande (§4.6)",
    () => assert.match(body, /SRL|BCE|TVA/));
  check("l'accueil porte l'avertissement sanitaire (§4.2)",
    () => assert.match(body, /modération/i));
  check("la jauge publique des quartiers est visible (§8.1)",
    () => assert.match(body, /Liste d'attente|\/\s*150/));
}

// ---------------------------------------------------------------- sign-up

await press('Créer un compte');
await shot('inscription');

{
  const body = await text();
  check("l'inscription annonce ce qui n'est jamais conservé",
    () => assert.match(body, /date de naissance n'est jamais enregistrée/i));
}

await fill('Prénom', 'Camille');
await fill('Nom', 'Dupont');
await fill('Adresse e-mail', `journey-${Date.now()}@example.invalid`);
await shot('inscription-remplie');

await press('Continuer');
await shot('verification');

{
  const body = await text();
  check("l'écran de vérification distingue ce qui est conservé et ce qui ne l'est pas",
    () => {
      assert.match(body, /tranche d'âge/i);
      assert.match(body, /Votre date de naissance/i);
    });
}

await press('Vérifier mon âge');
await page.waitForTimeout(1200);
await shot('consentements');

// ---------------------------------------------------------------- consents

{
  const continueButton = page.getByRole('button', { name: 'Continuer', exact: false })
    .filter({ visible: true }).first();
  const disabled = await continueButton.getAttribute('aria-disabled');
  check('on ne peut pas continuer sans accepter les consentements obligatoires',
    () => assert.equal(disabled, 'true'));
}

await tick("J'accepte les conditions générales d'utilisation");
await tick("J'accepte les conditions générales de vente");
await tick("J'ai pris connaissance de la politique de confidentialité");
await shot('consentements-coches');

{
  // Spec 6.2 and H-08: the optional boxes start unticked.
  const marketing = page.getByRole('checkbox', { name: /Me prévenir quand mon quartier ouvre/ })
    .filter({ visible: true }).first();
  const checked = await marketing.getAttribute('aria-checked');
  check('les consentements facultatifs sont décochés par défaut (§6.2)',
    () => assert.equal(checked, 'false'));
}

await press('Continuer');
await page.waitForTimeout(1200);
await shot('adresse');

// ---------------------------------------------------------------- address

await fill('Rue', 'Rue des Blancs Chevaux');
await fill('Numéro', '14');
await fill('Bâtiment ou kot-à-projet', 'Kot Carrefour');
await fill('Étage', '3');
await shot('adresse-remplie');

{
  const body = await text();
  check("l'épingle sur la carte est présentée comme obligatoire (§6.3)",
    () => assert.match(body, /Obligatoire.*GPS est imprécis/is));
}

await press('Enregistrer cette adresse');
await page.waitForTimeout(1800);
await shot('catalogue');

// ---------------------------------------------------------------- catalogue

{
  const body = await text();
  const firstAlcoholIndex = body.indexOf("Contient de l'alcool");
  const firstProductIndex = body.indexOf('Palette bière sans alcool');

  check('les produits sans alcool apparaissent en premier (§5)',
    () => assert.ok(firstProductIndex > -1 && firstProductIndex < firstAlcoholIndex,
      `sans alcool à ${firstProductIndex}, alcool à ${firstAlcoholIndex}`));

  check("tout produit alcoolisé affiche la mention et son degré (§5)",
    () => assert.match(body, /Contient de l'alcool — [\d,.]+% vol\./));

  check("aucun produit 18+ n'est proposé dans le MVP (§5, §22)",
    () => assert.ok(!/Spiritueux/i.test(body)));

  check('le prix est annoncé comme indicatif (§10)',
    () => assert.match(body, /Prix indicatif.*ticket de caisse/is));
}

const addButtons = page.getByRole('button', { name: 'Ajouter', exact: true })
  .filter({ visible: true });
await addButtons.nth((await addButtons.count()) - 1).click();
await page.waitForTimeout(600);
await shot('catalogue-ajout');

await press('Voir le panier');
await shot('panier');

await press('Continuer');
await shot('recapitulatif');

// ---------------------------------------------------------------- checkout

await press('Calculer le total');
await page.waitForTimeout(1800);
await shot('recapitulatif-total');

{
  const body = await text();

  // 1 pallet, 3rd floor without a lift, c = 1.0 → 350 + 3 × 50 = 500 cents.
  check("les frais de livraison suivent la formule du §9 (3e étage sans ascenseur → 5,00 €)",
    () => assert.match(body, /Frais de livraison\s*5,00 €/));

  check('les frais de service sont ceux du paramètre (0,49 €)',
    () => assert.match(body, /Frais de service\s*0,49 €/));

  check("le total TTC est affiché avant tout engagement (§4.6)",
    () => assert.match(body, /Total TTC\s*[\d,]+ €/));

  check("la règle d'écart avec le ticket est annoncée avant paiement (§10)",
    () => assert.match(body, /remboursée automatiquement/i));

  check("les conditions d'annulation sont affichées avant paiement (§4.6)",
    () => assert.match(body, /Annulation gratuite/i));

  check("le contrôle d'âge à la remise est annoncé (§13)",
    () => assert.match(body, /contrôlera la pièce d'identité/i));

  check("le libellé du bouton lève toute ambiguïté sur l'obligation de payer (§4.6)",
    () => assert.match(body, /Commander et payer/));

  check("le montant exact à payer est répété à côté du bouton",
    () => assert.match(body, /vous vous engagez à payer [\d,]+ €/));
}

await press('Commander et payer');
await page.waitForTimeout(1800);
await shot('suivi');

{
  const body = await text();
  check('le suivi affiche la référence de commande',
    () => assert.match(body, /Commande [A-Z0-9]{6,}/));
  check("le code de remise n'est pas affiché en clair avant l'arrivée (§13.4)",
    () => assert.ok(!/Code de remise\s*\d{4}/.test(body)));
}

await press("Simuler l'authentification et le paiement");
await page.waitForTimeout(2200);
await shot('suivi-paye');

{
  const body = await text();
  check('le paiement fait avancer la commande',
    () => assert.match(body, /Paiement reçu/));
  check("la recherche d'un palettier démarre après paiement (§6.8)",
    () => assert.match(body, /Recherche d'un palettier/));
  check("la chronologie n'expose ni acteur ni motif interne",
    () => assert.ok(!/actor|système|motif/i.test(body.split('Suivi')[1]?.slice(0, 400) ?? '')));
}

// ---------------------------------------------------------------- account

// Navigate through the UI rather than by URL. A full page load would drop the
// session, which lives in memory on purpose: persisting a bearer token in web
// storage is a real risk, and in production Supabase Auth owns session
// persistence (see HYPOTHESES.md H-21).
await press("Retour à l'accueil");
await page.waitForTimeout(1200);
await press('Mon compte');
await page.waitForTimeout(1500);
await shot('compte');

{
  const body = await text();
  check("le compte montre la tranche d'âge, jamais une date de naissance (§4.7)",
    () => {
      assert.match(body, /Tranche d'âge\s*18 ans et plus/);
      assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(body));
    });
  check("l'export et la suppression sont en libre-service (§6.13)",
    () => {
      assert.match(body, /Exporter mes données/);
      assert.match(body, /Supprimer mon compte/);
    });
  check('les consentements sont consultables et modifiables',
    () => assert.match(body, /Vos consentements/));
}

check("aucune erreur console sur l'ensemble du parcours",
  () => assert.deepEqual(consoleErrors, []));

await browser.close();

// ---------------------------------------------------------------- report

const failed = checks.filter(c => !c.ok);

console.log('\n════════ PARCOURS CLIENT ════════');
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`);
  if (!c.ok) console.log(`      ${c.error}`);
}
console.log(`\n${checks.length} vérifications, ${checks.length - failed.length} réussies, ${failed.length} en échec`);

if (SHOTS) console.log(`Captures : ${SHOTS}`);

process.exit(failed.length === 0 ? 0 : 1);
