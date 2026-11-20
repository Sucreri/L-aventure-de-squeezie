# Essayer l'app

Ce document sert à une chose : vous permettre de voir tourner l'application
sur votre machine, en quelques minutes.

Lisez d'abord la section suivante. Elle évite un malentendu coûteux.

---

## Ce que vous allez voir, et ce que vous ne verrez pas

**L'application est fonctionnelle.** Les deux parcours complets — client et
palettier — vont de bout en bout : inscription, vérification d'âge,
consentements, adresse, catalogue, panier, paiement, suivi, notation d'un
côté ; candidature, formation, contrat, créneaux, mission, achat en magasin,
contrôle d'âge, code PIN, gains de l'autre.

**L'application n'est pas prête à être lancée**, et la différence n'est pas
une question de finitions :

| Ce qui manque | Pourquoi ce n'est pas du code |
|---|---|
| La société (SRL) n'existe pas | Sans entité inscrite à la BCE, personne ne peut encaisser, payer ni employer |
| Aucun contrat avec un prestataire de paiement | Mollie et Stripe exigent une entreprise constituée |
| Aucun contrat de vérification d'identité | itsme aussi |
| Aucun contrat avec un secrétariat social | Sans lui, pas de barème, pas de Dimona, pas de fiche de paie |
| Les textes juridiques ne sont pas validés | Les 12 gabarits de `docs/legal/` portent tous « À FAIRE VALIDER PAR UN JURISTE » |
| Le back-office n'existe pas | Le paramétrage se fait pour l'instant en SQL |

Dans la démonstration, le **paiement** et la **vérification d'âge** sont donc
simulés. Rien n'est débité, aucune identité n'est vérifiée, aucun e-mail ni SMS
n'est envoyé. La base de données refuse d'ailleurs un prestataire simulé tant
qu'un paramètre ne l'autorise pas explicitement — ce qui empêche une
production mal configurée d'encaisser des paiements fictifs.

Tout le reste — les prix, les règles d'âge, les refus, les contrôles de droit
du travail, le cloisonnement entre comptes — est le vrai code, appliqué par la
vraie base de données.

---

## Prérequis

- **Node.js 22.6 ou plus** (`node --version`). C'est lui qui exécute le
  TypeScript directement, sans étape de compilation.
- **PostgreSQL 16**, soit via Docker, soit installé sur votre machine.

Rien d'autre. Le projet n'a qu'une seule dépendance applicative.

---

## Démarrer

```bash
git clone https://github.com/Sucreri/L-aventure-de-squeezie.git
cd L-aventure-de-squeezie
git checkout claude/new-session-ukc3l2

npm install

docker compose up -d      # PostgreSQL sur le port 5433
npm run demo              # construit l'app, prépare la base, démarre tout
```

La première exécution prend deux à trois minutes, l'essentiel étant la
construction du bundle web. Les suivantes : `npm run demo -- --skip-build`.

Puis ouvrez **http://localhost:8080**.

### Sans Docker

Si vous avez déjà un PostgreSQL 16 :

```bash
createdb uberpalette
PGHOST=localhost PGPORT=5432 PGUSER=votre_utilisateur npm run demo
```

Les scripts respectent `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` et
`PGDATABASE`.

---

## Visite guidée — côté client, 3 minutes

1. **Créer un compte.** N'importe quel e-mail : rien n'est envoyé, rien n'est
   vérifié auprès de qui que ce soit.
2. **Vérifier l'âge.** Le prestataire est simulé et répond immédiatement.
   Lisez l'écran : il énonce ce qui est conservé (une tranche d'âge) et ce qui
   ne l'est jamais (date de naissance, image de pièce d'identité). Ce n'est pas
   une promesse : le schéma n'a aucune colonne pour les accueillir.
3. **Consentements.** Les trois premiers sont obligatoires, les deux autres
   sont décochés par défaut. Essayez de continuer sans les cocher : le bouton
   reste inactif.
4. **Adresse.** Elle est pré-remplie sur Biéreau, le seul quartier ouvert.
   Pour voir un refus, mettez une latitude de 50,85 et une longitude de 4,37
   (Bruxelles) : le serveur refuse l'adresse.
5. **Catalogue.** Les produits sans alcool apparaissent en premier. Les
   produits alcoolisés portent leur degré et l'avertissement sanitaire. Aucun
   spiritueux : une contrainte de base de données interdit d'en activer un.
6. **Récapitulatif.** C'est l'écran le plus dense en obligations : prix total
   avant tout engagement, règle d'écart avec le ticket de caisse, conditions
   d'annulation, identité du vendeur, et un bouton dont le libellé ne laisse
   aucun doute sur l'obligation de payer.
   Avec une palette au 3e étage sans ascenseur, les frais de livraison font
   **5,00 €** : 3,50 € de base plus trois étages à 0,50 €.
7. **Paiement.** Bouton « Simuler l'authentification et le paiement » : il
   remplace la page du prestataire, qui n'existe pas encore.
8. **Suivi.** La chronologie n'affiche que des statuts et des horodatages —
   jamais l'identité de qui a agi ni les motifs internes.

### Puis, dans « Mon compte »

Exportez vos données, et supprimez votre compte. Les deux se font en un
bouton, sans passer par un support : c'est une obligation du RGPD, et le
contraire serait un « dark pattern » que le droit de la consommation interdit.

---

## Visite guidée — côté palettier, 5 minutes

Depuis l'accueil, **« Devenir palettier »**.

1. **Candidature.** Le moyen de transport détermine la capacité ; c'est le
   serveur qui la fixe, pas vous.
2. **Formation obligatoire.** Dix questions sur les âges légaux, le refus en
   cas d'ivresse, le contrôle d'une pièce d'identité, le port de charges, la
   sécurité à vélo. Les propositions sont mélangées différemment pour chaque
   palettier, et la correction se fait sur le serveur : l'app ne reçoit jamais
   le corrigé. Répondez faux volontairement : chaque erreur est expliquée.
3. **Contrat.** Affiché en entier avant signature, avec les montants issus des
   paramètres, et marqué comme gabarit en attente de validation juridique.

4. **À ce stade, l'équipe doit intervenir.** Dans un second terminal :

   ```bash
   npm run demo:admin
   ```

   Cela confirme la déclaration Dimona et publie un créneau. Ces deux actions
   sont volontairement hors de portée du palettier : confirmer une Dimona,
   c'est attester d'une déclaration faite à l'ONSS. Dans le produit réel,
   elles se feront depuis le back-office.

5. **Réserver le créneau.** Essayez d'en réserver un avant l'étape 4 : le
   serveur refuse, en disant laquelle des trois conditions manque.
6. **Passer une commande côté client** (dans un onglet de navigation privée,
   pour avoir deux sessions). L'offre arrive au palettier.
7. **L'offre** montre le poids, l'étage, la distance et la prime — mais pas
   l'adresse du client. Elle n'apparaît qu'après acceptation.
8. **La mission** guide étape par étape. Essayez « Signaler un problème sur
   cet article » : un compte à rebours démarre pendant lequel le client peut
   répondre.
9. **La remise.** Entrez le code PIN sans faire le contrôle d'âge : refusé.
   Le contrôle d'âge vient d'abord, le PIN ensuite — dans cet ordre, imposé
   par la base de données.

Pour connaître le code PIN d'une commande pendant la démonstration :

```bash
psql -h localhost -p 5433 -U postgres -d uberpalette \
  -c "select reference, status from orders order by created_at desc limit 5;"
```

Le PIN n'est stocké que haché : il n'est donc pas lisible. Pour la
démonstration, fixez-en un connu :

```bash
psql -h localhost -p 5433 -U postgres -d uberpalette \
  -c "select app.set_order_pin(id, '1234') from orders
      where reference = 'VOTRE_REFERENCE';"
```

---

## Vérifier par vous-même que ça tient

La démonstration montre que ça marche. Les tests montrent que ça résiste.

```bash
npm run test:all
```

Sept suites, environ 390 vérifications : la logique métier, les règles de
conformité dans la base, la cohérence entre les deux implémentations du
calcul de prix, la couche service, l'API sous Row Level Security réelle, et
les deux parcours complets exécutés dans un vrai navigateur.

Quelques-unes valent le coup d'œil, parce qu'elles vérifient des choses qu'on
ne peut pas constater en cliquant :

```bash
# Un client peut-il voir la commande d'un autre ?
scripts/test-api.sh 2>&1 | grep -i cloisonnement -A 6

# Un palettier peut-il se déclarer sous contrat ?
scripts/test-db.sh 2>&1 | grep -i "sous contrat"

# Le moteur de promotions accepte-t-il une remise sur l'alcool ?
scripts/test-db.sh 2>&1 | grep -i promotion
```

---

## Si quelque chose ne marche pas

| Symptôme | Cause probable |
|---|---|
| `Postgres n'est pas joignable` | `docker compose up -d` n'a pas été lancé, ou le port 5433 est pris |
| `node: --experimental-strip-types is not allowed` | Node trop ancien : il faut 22.6 ou plus |
| L'app affiche « Impossible de joindre le service » | L'API n'a pas démarré ; regardez le terminal de `npm run demo` |
| Aucune offre n'arrive au palettier | `npm run demo:admin` n'a pas été relancé après la réservation du créneau |

---

## Et après ?

`COMPLIANCE.md` donne l'état exigence par exigence, avec un statut honnête
pour chacune. `HYPOTHESES.md` liste les quinze questions ouvertes qui
attendent une réponse d'un juriste, d'un comptable, d'un secrétariat social
ou de l'AFSCA.

Ces réponses, et non du code supplémentaire, sont ce qui sépare aujourd'hui
cette application d'un lancement.
