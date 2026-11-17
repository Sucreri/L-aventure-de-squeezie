# Architecture

## 1. Principe directeur

> **Toute exigence de la partie 4 est appliquée par le serveur.**
> L'interface ne fait que refléter une décision déjà prise et déjà refusable
> côté base de données.

Concrètement, cela veut dire qu'un client qui contournerait l'app mobile et
appellerait l'API directement se heurterait aux mêmes refus. Les règles
bloquantes ne sont donc pas écrites dans l'app mobile, ni même dans une couche
de service : elles sont écrites comme **contraintes, triggers et fonctions
`SECURITY DEFINER` dans Postgres**, au plus près de la donnée.

Trois couches, du plus contraignant au plus souple :

| Couche | Rôle | Ce qui s'y trouve |
|--------|------|-------------------|
| **Base de données** | Vérité et refus | Contraintes `CHECK`, clés étrangères, triggers de garde, RLS, machine à états, tarification |
| **Edge Functions** | Orchestration et appels externes | Paiement, vérification d'identité, cartes de dépense, exports, webhooks |
| **Clients** | Présentation | App mobile (Expo), back-office (Next.js) |

## 2. Vue d'ensemble

```
┌───────────────────────────┐   ┌───────────────────────────┐
│  App mobile (Expo)        │   │  Back-office (Next.js)    │
│  Espaces :                │   │  Admin · Ops · Support    │
│   · Client                │   │  · RH (accès séparé)      │
│   · Palettier             │   └─────────────┬─────────────┘
│   · Ambassadeur           │                 │
└─────────────┬─────────────┘                 │
              │  HTTPS + JWT (Supabase Auth)  │
              └────────────┬──────────────────┘
                           ▼
         ┌─────────────────────────────────────────┐
         │  Supabase (région UE)                   │
         │                                         │
         │  PostgREST ──► Postgres                 │
         │                 · RLS par rôle          │
         │                 · triggers de garde     │
         │                 · app.* (fonctions)     │
         │                                         │
         │  Realtime  ──► suivi de mission         │
         │  Storage   ──► photos de tickets        │
         │  Edge Fn   ──► intégrations externes    │
         └───────┬─────────────────────────────────┘
                 │
     ┌───────────┼────────────┬─────────────┬──────────────┐
     ▼           ▼            ▼             ▼              ▼
  Paiement   Vérification  Cartes de    Secrétariat    Cartographie
  (Mollie/   d'âge         dépense      social         (Mapbox /
   Stripe)   (itsme)                    (CSV ou API)    Google)
```

## 3. Schémas Postgres

| Schéma | Contenu | Exposé à PostgREST |
|--------|---------|--------------------|
| `public` | Tables métier | Oui, filtré par RLS |
| `app` | Fonctions de domaine, garde-fous, helpers (tarification, âge, géo) | Non |
| `hr` | Données de paie sensibles (IBAN chiffré, registre national) | Non — accès par fonction, rôle `hr` uniquement |
| `audit` | Journal d'audit immuable, événements de commande | Lecture seule, admin |

La séparation de `hr` est délibérée : le numéro de registre national et l'IBAN
ne doivent jamais pouvoir fuiter par une politique RLS trop large sur `public`
(§4.7, minimisation). Ces colonnes sont chiffrées au repos et ne sont lisibles
que par une fonction `SECURITY DEFINER` qui vérifie le rôle `hr` et journalise
chaque lecture.

## 4. Décisions structurantes

### 4.1 Montants en centimes entiers

Tous les montants sont des `integer` de centimes. Aucun `numeric`, aucun
`float`. L'arrondi n'intervient qu'une seule fois, à la fin du calcul des frais
de livraison. C'est ce qui permet de garantir le critère §20.5 : *le total
affiché avant paiement est égal au montant débité*.

### 4.2 Machine à états explicite

Les transitions autorisées sont **des lignes d'une table** (`order_transitions`),
pas un `switch` dans le code. Un trigger `BEFORE UPDATE` sur `orders` refuse
toute transition absente de cette table. Conséquences :

- impossible d'oublier un cas ;
- la matrice est auditable par un juriste sans lire de code ;
- le critère §20 « 100 % des transitions sont testées » devient un simple
  parcours de table.

### 4.3 Paramètres plutôt que constantes

`app_settings` est une table clé → valeur `jsonb`, typée, catégorisée et
journalisée. Tout montant, seuil, horaire, texte légal et libellé en vient.
Deux garde-fous :

- une valeur de paramètre absente ne **prend pas** de valeur par défaut
  silencieuse : la fonction lève une erreur explicite ;
- certains paramètres n'ont volontairement **aucune valeur par défaut**
  (salaire horaire, références d'assurance), et leur absence bloque
  l'ouverture des créneaux (H-11).

### 4.4 Minimisation par la forme du schéma

Le meilleur moyen de ne pas stocker une donnée interdite est de ne pas lui
donner de colonne. Le schéma ne comporte donc :

- **aucune** colonne de date ou d'année de naissance ;
- **aucune** colonne ni bucket de stockage pour une image de pièce d'identité ;
- **aucune** colonne de position en dehors d'une mission active.

`age_checks` enregistre le résultat, le motif, l'horodatage et le palettier —
rien d'autre. C'est une garantie structurelle, pas une promesse de procédure.

### 4.5 Géographie sans PostGIS

Voir H-10. Deux fonctions PL/pgSQL (`app.point_in_polygon`, `app.haversine_m`)
remplacent PostGIS pour un périmètre d'une ville. Les signatures sont choisies
pour qu'un passage ultérieur à PostGIS ne change que leur corps.

### 4.6 Idempotence des paiements

Chaque `payments` porte une `idempotency_key` unique. Les webhooks du
prestataire sont rejoués sans effet de bord : un `INSERT ... ON CONFLICT DO
NOTHING` sur la clé, puis rapprochement. Le rapprochement
ticket ↔ dépense carte ↔ montant encaissé est une vue matérialisée avec alerte
au-delà d'un écart paramétrable (§4.5).

## 5. Organisation du dépôt

```
.
├── README.md                 Démarrage, commandes, état d'avancement
├── HYPOTHESES.md             Questions ouvertes et hypothèses (§0.2)
├── COMPLIANCE.md             Matrice exigence → code → test (§0.5)
├── .env.example              Aucune clé réelle
├── docs/
│   ├── ARCHITECTURE.md       Ce document
│   └── legal/                12 gabarits juridiques (§4.12)
├── supabase/
│   ├── migrations/           Schéma, garde-fous, RLS
│   ├── seed/                 Données de démonstration (§20)
│   └── tests/                Assertions SQL exécutables
├── packages/
│   └── domain/               Logique pure partagée + vecteurs de test
├── apps/
│   ├── mobile/               Expo (lots à venir)
│   └── backoffice/           Next.js (lots à venir)
└── scripts/                  Outillage local
```

## 6. Pourquoi la logique de domaine existe en double

La tarification est écrite **deux fois** : en SQL (autorité) et en TypeScript
(estimation affichée). C'est un choix assumé, pas un oubli. L'app doit pouvoir
afficher un prix instantanément et hors ligne, mais seul le serveur fait foi.

Le risque de divergence est neutralisé par
`packages/domain/src/pricing-vectors.json` : un même jeu de vecteurs alimente
les tests TypeScript **et** les assertions SQL. Toute divergence fait échouer la
suite de tests.
