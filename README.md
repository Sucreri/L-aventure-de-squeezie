# Palette — MVP de livraison à Louvain-la-Neuve

> **« Palette » est un nom de travail.** Le nom définitif doit être vérifié
> auprès du BOIP et de l'EUIPO avant publication (`HYPOTHESES.md` H-01, Q-01).
> Il n'apparaît nulle part en dur dans le code : c'est un paramètre.

Application de livraison à la demande de boissons et de snacks préemballés,
depuis les supermarchés de Louvain-la-Neuve jusqu'aux kots. L'équipe développe
et administre la plateforme ; elle ne livre pas. Clients et palettiers
s'inscrivent eux-mêmes.

## Le principe qui structure tout le dépôt

> **Une exigence de conformité n'est tenue que si le serveur la refuse.**

Les règles bloquantes de la partie 4 du cahier des charges ne sont pas écrites
dans l'application mobile, ni même dans une couche de service : elles sont des
**contraintes, triggers et fonctions dans Postgres**. Les tests le vérifient
systématiquement en tentant un `INSERT` ou un `UPDATE` direct, qui contourne
l'application comme le ferait un appel d'API malveillant.

Trois exemples :

- un produit `age_minimum = 18` ne peut pas être activé — contrainte `CHECK` ;
- une promotion ne peut pas désigner un produit — le type `promotion_target` ne
  comporte que `delivery_fee` et `service_fee` ;
- une commande contenant de l'alcool ne peut pas atteindre `DELIVERED` sans
  contrôle d'âge validé **puis** PIN correct — trigger, y compris sur un
  `UPDATE` direct.

## État d'avancement

| Lot | Contenu | État |
|-----|---------|------|
| Socle | Schéma, garde-fous serveur, RLS, paramètres, données de démonstration | ✅ |
| a | Comptes, consentements, vérification d'âge, adresses, zones, liste d'attente | ✅ base, service, API et app |
| b | Catalogue, panier, calcul de prix | ✅ base, service, API et app |
| c | Paiement, remboursements, reçus | 🟡 règles et écart du §10 faits et testés ; prestataire simulé, intégration Mollie ou Stripe à venir |
| d | Palettiers : candidature, formation, contrat, créneaux, missions, contrôle d'âge, PIN | ✅ base, service, API et app |
| e | Attribution, suivi temps réel, notifications | 🟡 attribution faite et testée ; temps réel et notifications à venir |
| f | Back-office, exports de paie et comptables | 🟡 tables, vues et exports faits ; interface à venir |
| g | Parrainage, codes partenaires, ambassadeurs, commande groupée, notation, incidents | 🟡 base faite ; notation exposée dans l'app, le reste à venir |
| h | Conservation, droits RGPD, sécurité, accessibilité | ✅ sauf audit d'accessibilité complet |
| Service | Ports, prestataires simulés, cas d'usage | ✅ |
| API | Surface HTTP, sous Row Level Security réelle | ✅ parcours client et palettier ; routes admin à venir |
| App client | Expo, vérifiée dans un navigateur | ✅ |
| App palettier | Candidature, formation, contrat, créneaux, missions, exécution guidée, remise, gains | ✅ (file hors ligne écrite, branchement des écrans à finir) |
| Back-office | Next.js | ⬜ pas commencé |

`COMPLIANCE.md` donne le détail exigence par exigence, avec un statut honnête
pour chacune.

## Démarrage

Prérequis : Node ≥ 22.6 (pour l'exécution native de TypeScript) et PostgreSQL 16.

```bash
cp .env.example .env     # puis renseigner les valeurs ; aucune clé n'est versionnée

# Base de données locale
scripts/db-reset.sh --seed    # reconstruit le schéma et charge les données de démonstration

# Vérifications — les six suites d'un coup
npm run test:all

# ou une par une
npm test                      # 84 tests du paquet domaine, sans dépendance
scripts/test-db.sh            # 101 assertions d'acceptation (partie 4 et §20)
scripts/check-parity.sh       # 24 vérifications de parité SQL ↔ TypeScript
scripts/test-services.sh      # 64 tests d'intégration de la couche service
scripts/test-api.sh           # 51 tests de l'API, sous Row Level Security réelle
scripts/test-app.sh           # 29 + 39 vérifications des parcours client et
                              # palettier, dans Chromium

# Lancer en local
npm run dev:api               # API sur http://localhost:8787
npm run dev:app               # app Expo (web, iOS, Android)
```

`scripts/test-app.sh --shots <dossier>` enregistre une capture par écran, utile
pour une relecture humaine. Ce sont les assertions qui font échouer la suite,
jamais les captures.

`npm run typecheck` est également disponible, après un `npm install` qui
installe TypeScript (le reste du dépôt n'a aucune dépendance : Node 22 exécute
les fichiers `.ts` directement et fournit le lanceur de tests).

Les suites doivent toutes passer. La suite d'acceptation **n'est pas
idempotente** : elle crée des jeux d'essai et ouvre des quartiers, donc
`scripts/test-db.sh` reconstruit toujours la base avant de l'exécuter.

### Connexion à la base de test locale

Les scripts visent par défaut un cluster local sur le port 5433. Pour pointer
ailleurs :

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=palette scripts/db-reset.sh --seed
```

## Organisation du dépôt

```
README.md             Ce fichier
HYPOTHESES.md         Questions ouvertes et hypothèses prises (§0.2)
COMPLIANCE.md         Matrice exigence → code → test (§0.5)
.env.example          Aucune clé réelle
docs/
  ARCHITECTURE.md     Décisions structurantes et leur justification
  legal/              12 gabarits juridiques (§4.12)
supabase/
  migrations/         34 migrations, appliquées dans l'ordre
  seed/               Données de démonstration (§20)
  tests/              Suite d'acceptation exécutable
packages/
  domain/             Logique métier partagée + vecteurs de test
  services/           Orchestration : ports, prestataires simulés, cas d'usage
apps/
  api/                Surface HTTP ; deviendra des Edge Functions Supabase
  mobile/             App cliente Expo
scripts/              pg-start, db-reset, test-*, check-parity
```

## Trois choses à savoir avant de lire le code

**1. La tarification existe en double, volontairement.**
`app.compute_delivery_fee` en SQL fait autorité ; la version TypeScript permet
à l'app d'afficher un prix instantanément et hors ligne. Les deux sont tenues
en phase par `packages/domain/src/pricing-vectors.json`, rejoué contre les deux
implémentations par `scripts/check-parity.sh`. Toute divergence fait échouer la
suite.

**2. Le serveur refuse, le client affiche.**
L'app ne calcule aucun prix et ne décide d'aucune règle : elle demande au
serveur, qui applique les contraintes de la base. Chaque requête d'un
utilisateur s'exécute sous le rôle `authenticated` avec son identité, donc la
Row Level Security s'applique réellement — et un client qui demande la
commande d'un autre reçoit 404, pas 403 : l'existence même de la commande ne
doit pas fuiter.

**3. Certains paramètres n'ont volontairement aucune valeur par défaut.**
Le salaire horaire, la commission paritaire, les références d'assurance
accidents du travail et de service externe de prévention sont `null` au départ.
Inventer un salaire aurait été une faute. Tant qu'ils ne sont pas renseignés,
`app.launch_blockers()` les liste et **aucun quartier ne peut ouvrir, aucun
créneau ne peut être publié**.

## Ce qui est hors périmètre

Spiritueux · livraison hors Louvain-la-Neuve · mode « je passe au Spar » entre
particuliers · stock propre · intégration directe des magasins · abonnement de
type « Pass » · activation du mode `INDEPENDENT`.

Plusieurs de ces points ne sont pas seulement « non développés » : ils sont
**verrouillés par une contrainte de base de données ou un double verrou
serveur**, pour qu'une évolution ultérieure ne puisse pas les réintroduire par
inadvertance. Le test `20.8` le prouve pour le mode `INDEPENDENT`.

## Avant le lancement

Le code peut être conforme sans que le service soit légal. La checklist du
cahier des charges liste les démarches que seule l'équipe peut accomplir :
constitution de la SRL, secrétariat social, juriste, comptable, AFSCA, dépôt du
nom, assurance, DPA avec chaque prestataire, accord du gérant du magasin,
relecture des visuels, fiches des stores.

`HYPOTHESES.md` recense les 15 questions ouvertes qui bloquent ou orientent ces
démarches.

---

*Ce dépôt ne constitue pas un avis juridique.*
