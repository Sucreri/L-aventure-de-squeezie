# HYPOTHESES.md

> Registre des questions ouvertes et des hypothèses prises faute de réponse.
> Règle appliquée (§0.2 du cahier des charges) : **en l'absence d'information,
> on retient l'option la plus prudente juridiquement et on la consigne ici.**
> Chaque hypothèse porte un identifiant stable, référencé depuis le code et
> depuis `COMPLIANCE.md`.

Statuts : `OUVERT` (réponse attendue) · `HYPOTHÈSE` (choix pris, réversible) ·
`TRANCHÉ` (validé par le porteur de projet ou un conseil externe).

---

## 1. Reformulation du besoin (10 lignes)

1. Un client de Louvain-la-Neuve commande dans une app des boissons et snacks
   préemballés vendus par les supermarchés du centre.
2. L'Opérateur (une SRL belge inscrite à la BCE, avec numéro de TVA) achète ces
   produits en magasin **pour le compte du client** et les lui refacture au prix
   exact du ticket de caisse, sans marge.
3. La marge de l'Opérateur vient exclusivement des frais de livraison et de
   service, jamais des produits et jamais de l'alcool.
4. La course est exécutée par un « palettier » : un étudiant **salarié** sous
   contrat d'occupation d'étudiant, déclaré en Dimona, payé à l'heure.
5. L'équipe fondatrice développe et administre la plateforme ; elle ne livre
   jamais elle-même. Clients et palettiers s'inscrivent seuls.
6. L'âge est contrôlé trois fois : à l'inscription, à la commande (serveur) et à
   la remise physique (palettier), parce que l'offre contient de la bière.
7. L'argent des clients ne transite jamais par l'Opérateur directement : un
   prestataire agréé (Mollie ou Stripe) encaisse, rembourse et porte la SCA.
8. L'ouverture se fait quartier par quartier, par liste d'attente à double seuil,
   parce qu'un palettier salarié coûte son salaire même à l'arrêt.
9. Tout montant, seuil, horaire, texte légal et produit est un **paramètre**
   modifiable en back-office : rien n'est codé en dur.
10. Les exigences de conformité de la partie 4 sont **bloquantes** : aucune
    fonctionnalité, promotion ou optimisation ne peut les contourner.

---

## 2. Questions ouvertes (réponse attendue du porteur de projet)

| ID | Question | Pourquoi c'est bloquant | Qui répond |
|----|----------|-------------------------|------------|
| Q-01 | Quel est le nom définitif de l'app (`NOM_APP`) ? | Identifiants de paquets, noms de stores, dépôt de marque. Voir H-01. | Équipe + BOIP/EUIPO |
| Q-02 | Identité exacte de l'Opérateur : dénomination, numéro BCE, numéro de TVA, siège, e-mail de contact, téléphone ? | Obligatoire sur les mentions légales, les reçus, les e-mails et avant toute commande (§4.6). | Équipe (après constitution de la SRL) |
| Q-03 | Quel est le régime TVA de la refacturation des produits au prix du ticket ? Débours au sens de l'article 28, 5° du Code de la TVA, ou achat-revente ? | Détermine la structure des factures, la base imposable et les taux par ligne. | Comptable |
| Q-04 | Quelle commission paritaire s'applique et quel est le barème horaire exact ? | Aucune valeur par défaut n'est acceptable pour un salaire (§11). Le champ reste `NULL` tant que la réponse manque. | Secrétariat social |
| Q-05 | Les pourboires sont-ils soumis aux cotisations ONSS et au précompte, et à quel régime ? | Détermine le calcul de la paie et l'export vers le secrétariat social. | Secrétariat social |
| Q-06 | La récompense des ambassadeurs est-elle un crédit commercial ou une rémunération ? | Un crédit non monétaire évite la requalification en revenu professionnel ; à trancher avant d'activer le programme. | Juriste + comptable |
| Q-07 | Un enregistrement AFSCA est-il requis pour la distribution et la garde 24 h de produits préemballés ? | Paramètre `afsca_registration_ref` bloquant à l'ouverture du premier quartier (§4.11). | AFSCA |
| Q-08 | Le droit de rétractation s'applique-t-il, et quelles exceptions retient-on (biens périssables, service pleinement exécuté) ? | Texte affiché avant paiement et rappelé dans la confirmation (§4.6). | Juriste |
| Q-09 | Quel est le sort des articles non réclamés après la garde de 24 h au local ? | À fixer dans les CGV (§12). | Juriste |
| Q-10 | Le local de l'Opérateur (`HELD_AT_HUB`) existe-t-il, et à quelle adresse ? | Conditionne la procédure d'échec de remise et les conditions de stockage. | Équipe |
| Q-11 | Quel est le seuil de dérogation au travail de nuit accepté par le secrétariat social, et sous quelle forme écrite ? | Débloque les créneaux après 20 h (§14). | Secrétariat social |
| Q-12 | Quelle assurance accidents du travail et quel service externe de prévention ? | Références stockées dans l'app ; leur absence bloque l'ouverture des créneaux (§4.3). | Équipe |
| Q-13 | Le gérant du Spar accepte-t-il le volume d'achats et un éventuel passage prioritaire en caisse ? | Risque opérationnel majeur, hors code. | Équipe |
| Q-14 | Quel est le plafond par carte de dépense et par mission ? | Paramètre `spend_card_ceiling_cents` ; une valeur prudente est prise par défaut (H-09). | Équipe + prestataire |
| Q-15 | Quels prestataires exacts signe-t-on (hébergeur, paiement, SMS, cartes, vérification d'identité, secrétariat social) ? | Un DPA par prestataire est exigé avant la mise en production (§4.7). | Équipe + juriste |

---

## 3. Hypothèses prises

### Produit et marque

| ID | Hypothèse | Justification | Réversibilité |
|----|-----------|---------------|---------------|
| H-01 | Le nom de travail est **« Palette »**, exposé uniquement via le paramètre `app.display_name` et la variable `APP_NAME`. Aucune chaîne de caractères de marque n'est écrite en dur dans le code, ni dans les identifiants de paquets. | Le nom définitif dépend d'une recherche d'antériorité BOIP/EUIPO (§4.10) non encore faite. La marque « Uber » n'apparaît nulle part : elle n'est qu'un nom de travail dans le cahier des charges. | Changer une valeur de paramètre et un identifiant de bundle. |
| H-02 | Aucun logo, visuel ou nom de tiers (Uber, Carapils, Spar, Delhaize) n'est embarqué. Les produits portent un libellé générique (« Palette de bière blonde 24 × 33 cl ») et une photo prise par l'Opérateur. | §4.10 interdit l'habillage de marque tiers. Le droit des marques belge ne permet pas de reprendre un logo sans licence, même pour décrire un produit revendu. | Un accord écrit de licence rendrait l'affichage possible. |

### Juridique et conformité

| ID | Hypothèse | Justification | Réversibilité |
|----|-----------|---------------|---------------|
| H-03 | Le modèle palettier est **`STUDENT_EMPLOYEE` uniquement**. `INDEPENDENT` est codé mais verrouillé par un double verrou : un paramètre serveur et le téléversement obligatoire d'un avis juridique écrit. | §2 et §4.4. Comme l'app fixe les prix, attribue les missions et géolocalise, la présomption légale de salariat des travailleurs de plateforme s'applique presque certainement. | Déverrouillage par super-admin après avis juridique. |
| H-04 | Aucune date de naissance, aucune année de naissance et aucune image de pièce d'identité n'est stockée, nulle part, à aucun moment. Seuls sont conservés : la tranche d'âge (`16_17` / `18_plus`), le booléen de vérification, la méthode et l'horodatage. | §4.7 (minimisation) et §13.2. La loi belge encadre strictement la lecture et la copie de l'eID. Le schéma ne comporte volontairement **aucune colonne** pouvant accueillir ces données. | Non réversible sans AIPD complémentaire. |
| H-05 | L'âge minimum de la bière est fixé à **16 ans** et celui des spiritueux à 18 ans, mais tout produit avec `age_minimum = 18` est **interdit d'activation** dans le MVP par une contrainte de base de données. | §4.1 et §5. Les spiritueux sont hors périmètre (§22). | Lever la contrainte après décision explicite. |
| H-06 | Le moteur de promotions **refuse structurellement** toute règle qui touche une ligne contenant de l'alcool, même indirectement (remise panier, seuil de quantité, cadeau). Les promotions ne peuvent porter que sur `delivery_fee` et `service_fee`. | §4.1 et §4.2, Convention belge en matière de publicité pour l'alcool du 22 avril 2026. Le refus est implémenté par un trigger serveur, pas par une validation d'interface. | Non réversible : exigence bloquante. |
| H-07 | Le droit de rétractation est traité comme **applicable par défaut**, avec un texte paramétrable et une exception à confirmer par un juriste (Q-08). | Option la plus protectrice pour le consommateur en cas de doute (§0.2). | Paramètre `consumer.withdrawal_policy_id`. |
| H-08 | Les communications marketing sont **décochées par défaut**, consentement distinct par canal, et toute communication mettant en avant un produit alcoolisé porte le drapeau `mentions_alcohol` qui impose l'avertissement sanitaire et une audience 18+. | §4.2 et §6.2. | Non réversible. |

### Technique et opérationnel

| ID | Hypothèse | Justification | Réversibilité |
|----|-----------|---------------|---------------|
| H-09 | Plafond par carte de dépense : **80,00 €** par mission par défaut, et refus automatique au-delà. | Couvre largement 6 unités au prix indicatif maximal observé, sans exposer l'Opérateur. Paramètre `courier.spend_card_ceiling_cents`. | Paramètre. |
| H-10 | **Pas de dépendance à PostGIS.** Les zones sont des polygones GeoJSON en `jsonb` et les adresses des couples latitude/longitude. L'appartenance à une zone et les distances sont calculées par des fonctions PL/pgSQL (`app.point_in_polygon`, `app.haversine_m`). | §18 autorise une autre stack si elle est justifiée. Le périmètre est une ville de 2 km² avec une poignée de polygones : un test de rayon et un point-dans-polygone en PL/pgSQL suffisent, restent exacts et rendent le schéma testable sur un Postgres nu. Les signatures de fonctions sont stables, donc un passage à PostGIS plus tard ne change que leur corps. | Remplacer le corps de deux fonctions. |
| H-11 | Le salaire horaire est **`NULL` par défaut** et l'ouverture de créneaux est bloquée tant qu'il n'est pas renseigné par l'admin, de même que les références d'assurance accidents du travail, de service externe de prévention et de règlement de travail. | §11 n'admet aucune valeur par défaut pour un salaire, et §4.3 exige ces documents avant toute prestation. Un salaire par défaut inventé serait une faute. | Saisie en back-office après Q-04. |
| H-12 | `heure_fin_service` = **22 h 00**, et aucun créneau ne peut être publié au-delà de 20 h sans la case « Dérogation validée par le secrétariat social » cochée, action journalisée avec son auteur. | §14 et §4.3. Le travail de nuit (20 h – 6 h) est en principe interdit en droit belge. | Paramètre + case à cocher tracée. |
| H-13 | Le PIN de remise est un code à 4 chiffres **stocké uniquement haché** (bcrypt via `pgcrypto`), jamais en clair, jamais dans les journaux. | §4.8. | Non réversible. |
| H-14 | Les montants sont manipulés en **entiers de centimes** (`integer`), jamais en flottants, et l'arrondi des frais se fait au centime le plus proche (demi vers le haut) à la toute fin du calcul. | Évite les écarts de centimes entre l'estimation affichée et le montant débité, exigés identiques par le critère d'acceptation §20.5. | Non réversible. |
| H-15 | Le MVP n'a **aucune intégration magasin**. Un magasin est un point d'achat configuré (adresse, horaires, produits, prix indicatifs) dont les prix sont mis à jour à la main par l'admin. | §4 du cahier des charges, table « Magasin ». | Intégration ultérieure. |
| H-16 | Les prix indicatifs sont par magasin et datés (`price_updated_at`). Un écart répété entre prix indicatif et ticket déclenche une alerte admin au-delà d'un seuil paramétrable. | §10. | Paramètre. |
| H-17 | L'hébergement est contraint à une **région de l'Union européenne** ; le code ne contient aucun point d'accès hors UE. Les prestataires hors UE sont refusés par défaut au niveau de la revue des DPA. | §4.7 et §18. | Non réversible sans analyse de transfert. |
| H-18 | Le coefficient d'affluence `c` est borné à **[1,00 ; 1,50]** par une contrainte de base de données, identique pour tous les clients d'une zone au même instant, et journalisé à chaque changement. | §9. Un coefficient personnalisé serait une pratique commerciale déloyale. | Non réversible. |
| H-19 | Le libellé du bouton de paiement est le paramètre `checkout.pay_button_label`, valeur par défaut « Commander et payer », et une contrainte interdit une valeur qui ne contient pas un verbe de paiement. | §4.6, obligation d'un libellé sans ambiguïté sur l'obligation de payer. | Paramètre borné. |
| H-20 | Les comptes inactifs sont supprimés après **24 mois**, avec préavis par e-mail 30 jours avant, par une tâche automatique journalisée. | §4.7. | Paramètre. |
| H-21 | Le jeton de session n'est **pas persisté** côté client : il vit en mémoire et une actualisation de page oblige à se reconnecter. | Écrire un jeton porteur dans le stockage du navigateur l'expose à toute faille XSS. En production, c'est Supabase Auth qui détient la session, avec un jeton de rafraîchissement et une rotation : le mécanisme actuel n'est qu'un substitut en attendant le projet Supabase. Ne pas le persister maintenant évite d'inscrire une mauvaise habitude dans le code. | Remplacé par Supabase Auth. |

---

## 4. Points explicitement hors périmètre (rappel §22)

Spiritueux · livraison hors Louvain-la-Neuve · mode « je passe au Spar » entre
particuliers · stock propre · intégration directe des magasins · abonnement de
type « Pass » · activation du mode `INDEPENDENT`.

Ces éléments ne sont pas seulement « pas développés » : plusieurs sont
**bloqués par une contrainte de base de données ou un verrou serveur**, pour
qu'une évolution ultérieure ne puisse pas les réintroduire par inadvertance.
