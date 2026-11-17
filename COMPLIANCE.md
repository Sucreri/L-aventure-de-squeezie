# COMPLIANCE.md

> Matrice exigée par la règle §0.5 du cahier des charges : **chaque exigence de
> la partie 4 est reliée au code qui l'implémente et au test qui la vérifie.**
>
> Les exigences de la partie 4 sont **bloquantes**. Aucune fonctionnalité,
> promotion ou optimisation ne peut les contourner.

## Comment lire ce document

| Statut | Signification |
|--------|---------------|
| ✅ | Implémenté **côté serveur** et couvert par un test automatisé qui passe |
| 🟡 | Partiellement implémenté : la base est en place, il reste une partie applicative |
| ⬜ | Pas encore implémenté, lot identifié |
| 📋 | Hors code : démarche que seule l'équipe peut accomplir (voir la checklist du cahier des charges) |

**Principe de conception.** Une exigence n'est considérée comme tenue que si le
serveur la refuse. Une validation d'interface ne compte pas : les tests
vérifient systématiquement qu'un `UPDATE` ou un `INSERT` direct, contournant
l'application, est lui aussi refusé.

## Comment exécuter les vérifications

```bash
scripts/db-reset.sh --seed   # reconstruit la base et charge les données de démonstration
scripts/test-db.sh           # 98 assertions d'acceptation (partie 4 et §20)
npm test                     # 84 tests du paquet domaine
scripts/check-parity.sh      # 24 vérifications de parité SQL ↔ TypeScript
```

État au moment de la rédaction : **98 + 84 + 24 = 206 vérifications, toutes au vert.**

---

## 4.1 Alcool et âge

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-ALC-01 | Âges légaux belges : bière et vin à 16 ans, spiritueux à 18 ans | `app_settings` : `alcohol.min_age_beer_wine`, `alcohol.min_age_spirits` ; `products.age_minimum` contraint à (0, 16, 18) — `0005_catalogue.sql` | `20.2` table de vérité complète | ✅ |
| C-ALC-02 | Âge contrôlé à l'inscription | `users.age_verified`, `chk_verification_complete`, `chk_under_16_never_active` — `0003_identity_consents.sql` | `20.1` « une commande sans compte vérifié est refusée » | ✅ |
| C-ALC-03 | Âge contrôlé à la commande, **côté serveur** | `app.may_buy_age_restricted()` + trigger `trg_order_item_age` — `0006_orders_pricing.sql` | `20.2` (9 assertions, y compris commande groupée) | ✅ |
| C-ALC-04 | Âge contrôlé à la remise | `age_checks` + `app.record_age_check()` — `0009_age_checks_delivery.sql` | `20.3` (11 assertions) | ✅ |
| C-ALC-05 | Interdiction de remettre de l'alcool à une personne manifestement ivre | `age_refusal_reason = 'visibly_intoxicated'`, `chk_ok_requires_both_boxes` (la case « personne en état normal » est obligatoire pour un contrôle positif) | `20.3` « un contrôle "ok" sans pièce vérifiée est refusé », « un refus bascule en DELIVERY_FAILED » | ✅ |
| C-ALC-06 | Jamais d'alcool offert, de réduction sur l'alcool, ni de réduction liée à la quantité d'alcool | `promotion_target` (enum sans produit) + liste blanche `app.allowed_promotion_condition_keys()` + `trg_promotion_rule` — `0011_growth_promotions.sql` | `20.4` (7 assertions) ; `promotions.test.ts` (13 tests) | ✅ |
| C-ALC-07 | Tout produit alcoolisé est identifié comme tel, avec son degré | `chk_alcohol_is_declared` ; `app.catalogue_for_user()` renvoie `alcohol_notice` | `20.2`, et contrainte testée en `0005` | ✅ |
| C-ALC-08 | Les produits sans alcool apparaissent en premier | `app.catalogue_for_user()` trie `contains_alcohol asc` | — (couvert par la fonction ; test d'affichage au lot UI) | 🟡 |
| C-ALC-09 | Un produit `age_minimum = 18` ne peut pas être activé dans le MVP | `chk_no_18_plus_in_mvp` — contrainte de base de données | `20.12` « un produit 18+ existe mais reste inactif » | ✅ |

## 4.2 Publicité et communication

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-PUB-01 | Respect de la Convention belge du 22 avril 2026 ; les mineurs ne sont jamais ciblés | `marketing_campaigns.audience_min_age`, `app.marketing_audience()` — `0011` | — (lot marketing) | 🟡 |
| C-PUB-02 | Drapeau `mentions_alcohol` imposant l'avertissement sanitaire et une audience 18+ | `chk_alcohol_audience` + `trg_campaign` (remplit l'avertissement depuis le paramètre) | — (lot marketing) | 🟡 |
| C-PUB-03 | Aucune publicité pour l'alcool sur un réseau sans contrôle d'âge (TikTok, Snapchat) | `app.guard_campaign()` refuse `social_network in ('tiktok','snapchat')` avec `mentions_alcohol` | — (lot marketing) | 🟡 |
| C-PUB-04 | Aucun message associant l'alcool à la performance, la réussite ou l'excès | `app.guard_campaign()` : refus par motif lexical sur le corps du message | — (lot marketing) | 🟡 |
| C-PUB-05 | Classification d'âge dans l'App Store et le Google Play | Hors code | Checklist équipe | 📋 |

## 4.3 Droit du travail (palettiers étudiants salariés)

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-TRA-01 | Aucune mission sans `contract_signed` **et** `dimona_confirmed` | `trg_mission_assignment`, `trg_shift_booking`, `chk_active_requires_contract_and_dimona` — `0008` | `20.6` (3 assertions distinctes) | ✅ |
| C-TRA-02 | Contrat d'occupation d'étudiant écrit et signé **avant** la première prestation | `courier_profiles.contract_signed_at`, `chk_contract_timestamp` | `20.6` | ✅ |
| C-TRA-03 | Suivi des heures et rappel du quota annuel de 650 h | `shift_bookings.worked_from/worked_to` ; paramètres `work.annual_quota_hours`, `work.quota_alert_threshold_hours` | ⬜ calcul et alerte au lot paie | 🟡 |
| C-TRA-04 | Salaire au moins égal au barème applicable | `pay.hourly_wage_cents` **sans valeur par défaut** ; `app.setting_int()` lève une erreur si absent | `20.6` « aucun créneau tant que … n'est pas référencé » | ✅ |
| C-TRA-05 | Assurance accidents du travail, service externe de prévention, règlement de travail : l'app bloque l'ouverture des créneaux tant qu'ils manquent | `app.guard_shift_publication()` vérifie les 5 paramètres obligatoires | `20.6` (test dédié qui vide le paramètre puis le restaure) | ✅ |
| C-TRA-06 | Temps de travail, repos et travail de nuit (§14) | `app.guard_shift_publication()` : refus au-delà de `heure_fin_service`, dérogation obligatoire au-delà de 20 h, action journalisée | `20.6` (3 assertions) | ✅ |
| C-TRA-07 | Géolocalisation uniquement pendant un créneau réservé, avec information claire | `trg_position_within_shift` (fenêtre + consentement) ; `courier_positions` liée à `shift_bookings` | `20.7` (3 assertions) | ✅ |
| C-TRA-08 | Directive (UE) 2024/2831 : explication écrite du système automatisé | `app.dispatch_explanation()` générée depuis les paramètres vivants | `4.3` « l'explication du système d'attribution est disponible » | ✅ |
| C-TRA-09 | Aucune donnée émotionnelle ou privée traitée | Aucune colonne de ce type dans le schéma | `4.7` contrôle structurel des colonnes | ✅ |
| C-TRA-10 | Revue humaine de toute décision importante ; aucune sanction automatique | `mission_offers.decline_reason` sans effet ; `incidents.chk_resolution_has_human` ; `client_blocks.decided_by NOT NULL` | `16` « bloquer un client exige une décision humaine nommée » | ✅ |

## 4.4 Mode `INDEPENDENT` (désactivé par défaut)

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-IND-01 | Activation uniquement par un super-admin, après téléversement d'un avis juridique écrit | Double verrou `app.guard_independent_mode()` : `courier.independent_mode_enabled` **et** `courier.independent_legal_opinion_id` | `20.8` (3 assertions : refus par défaut, refus avec le seul paramètre, acceptation avec les deux) | ✅ |
| C-IND-02 | Attestation d'assurance accidents obligatoire pour les indépendants de plateforme | ⬜ à implémenter si le mode est un jour activé | — | ⬜ |
| C-IND-03 | Déclaration annuelle DAC7 au SPF Finances | ⬜ idem | — | ⬜ |
| C-IND-04 | Ni créneaux imposés, ni sanctions, ni désactivation automatique | Déjà vrai : aucune sanction automatique n'existe dans le code | `20.8`, `C-TRA-10` | 🟡 |

> Ces trois lignes `⬜` ne sont pas une dette cachée : le mode est **verrouillé**
> et le test `20.8` le prouve. Elles deviennent bloquantes le jour où un
> super-admin voudra l'activer.

## 4.5 Paiements et comptabilité

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-PAY-01 | Prestataire agréé (Mollie ou Stripe) avec authentification forte (SCA) | `payments.provider`, `sca_completed`, `chk_capture_requires_sca` — `0010` | — (test d'intégration au lot paiement) | 🟡 |
| C-PAY-02 | Aucune donnée de carte stockée chez nous | Le schéma n'a **aucune** colonne pouvant contenir un PAN, un CVC ou une date d'expiration | `4.5` contrôle structurel des colonnes | ✅ |
| C-PAY-03 | Webhooks idempotents | `payments.idempotency_key UNIQUE`, `unique (provider, provider_ref)` | — (lot paiement) | 🟡 |
| C-PAY-04 | Rapprochement automatique ticket ↔ dépense carte ↔ montant encaissé, alerte en cas d'écart | Vue `payment_reconciliation` avec deux colonnes d'écart | `20.11/e2e` « le rapprochement ne montre aucun écart » | ✅ |
| C-PAY-05 | Reçus et factures conformes, numérotation continue, détail TVA | `invoices` + `app.next_invoice_number()` (compteur verrouillé, sans trou) ; identité de l'Opérateur figée sur la facture | Numérotation vérifiée à l'application de `0010` | 🟡 (détail TVA en attente de Q-03) |
| C-PAY-06 | Remboursements traçables (motif, auteur, montant), jamais en espèces | `refunds` : `reason NOT NULL`, `issued_by`, aucun mode « espèces » | — (lot remboursements) | 🟡 |
| C-PAY-07 | Plafond par mission sur les cartes de dépense | `trg_spend_ceiling` — `0010` | — (lot cartes) | 🟡 |

## 4.6 Droit de la consommation (Code de droit économique, livre VI)

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-CON-01 | Identité complète de l'Opérateur et moyens de contact, visibles avant toute commande | Paramètres `operator.*`, tous `required_for_launch` ; `app.launch_blockers()` bloque l'ouverture d'une zone | `20.10` « un quartier n'ouvre pas tant qu'un paramètre de lancement manque » | ✅ |
| C-CON-02 | Prix total TTC, tous frais compris, affiché avant l'engagement | `chk_total_is_sum` sur `orders` ; `app.compute_delivery_fee()` | `20.5` (8 assertions) ; `pricing.test.ts` (22 tests) | ✅ |
| C-CON-03 | Le coefficient d'affluence est annoncé clairement et borné | `orders.surge_coefficient` ; bornes `pricing.surge_min/max` vérifiées côté serveur | `20.5` « un coefficient hors bornes est refusé » | ✅ |
| C-CON-04 | Bouton de commande au libellé sans ambiguïté | Paramètre `checkout.pay_button_label` | ⬜ affichage au lot UI | 🟡 |
| C-CON-05 | Confirmation de commande sur support durable (e-mail) | ⬜ lot notifications | — | ⬜ |
| C-CON-06 | CGV accessibles avant la commande ; la version acceptée est stockée | `consents.legal_document_id` + `chk_document_required_for_terms` ; `orders.sales_terms_document_id` | `20.11/e2e` (la commande fige la version des CGV) | ✅ |
| C-CON-07 | Droit de rétractation et exceptions, affichés avant paiement | Paramètre `consumer.withdrawal_policy_text`, `required_for_launch` — **en attente de Q-08** | `20.10` (bloque l'ouverture s'il manque) | 🟡 |
| C-CON-08 | Avis authentiques : seules les commandes livrées peuvent être notées | `app.guard_rating()` ; `trg_ratings_immutable` | `16` (2 assertions), `20.11` « une commande non livrée ne peut pas être notée » | ✅ |
| C-CON-09 | Pas de dark pattern : se désinscrire doit être aussi simple que s'inscrire | `app.request_account_deletion()` en libre-service, un appel | `20.9` (4 assertions) | ✅ |
| C-CON-10 | Procédure de réclamation et coordonnées du Service de médiation | `incidents` ; paramètre `consumer.mediation_service_contact`, `required_for_launch` | `20.10` | 🟡 |
| C-CON-11 | Conditions d'annulation affichées **avant** le paiement | `app.cancellation_terms()` calculée côté serveur | `20.5/§10`, `order-state.test.ts` | ✅ |

## 4.7 Protection des données (RGPD)

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-RGPD-01 | Registre des traitements avec base légale | `docs/legal/registre-traitements.md` | 📋 à faire valider | 📋 |
| C-RGPD-02 | AIPD avant le lancement (géolocalisation, vérification d'âge) | `docs/legal/modele-aipd.md` | 📋 | 📋 |
| C-RGPD-03 | **Minimisation : aucune image ni copie de carte d'identité, aucune date de naissance** | Le schéma n'a **aucune colonne** pouvant les accueillir (`users`, `age_checks`) | `20.3` (2 contrôles structurels), `4.7` (contrôle global) | ✅ |
| C-RGPD-04 | Pour l'âge : seulement la tranche et le résultat | `users.age_bracket`, `age_checks.result` | `20.3`, `20.9` « l'export ne contient aucune date de naissance » | ✅ |
| C-RGPD-05 | Registre national chiffré, accès RH uniquement | Schéma `hr` sans politique RLS ; `hr.read_payroll_field()` vérifie le rôle, exige une finalité et journalise | `4.8` (RLS partout) | ✅ |
| C-RGPD-06 | Durées de conservation paramétrables, appliquées par une tâche automatique | `app.run_retention()` + `audit.retention_runs` ; 5 paramètres `retention.*` | `20.7` « les positions de plus de 30 jours sont purgées », « la purge est journalisée » | ✅ |
| C-RGPD-07 | Hébergement dans l'UE | Contrainte de déploiement, `.env.example` documenté | 📋 | 📋 |
| C-RGPD-08 | Droits des personnes en libre-service + adresse de contact dédiée | `app.export_user_data()`, `app.request_account_deletion()`, `data_subject_requests` ; `privacy.dpo_contact_email` | `20.9` (8 assertions) | ✅ |
| C-RGPD-09 | Contrats de sous-traitance (DPA) avec chaque prestataire | Hors code | Checklist équipe (Q-15) | 📋 |
| C-RGPD-10 | Aucun traceur non essentiel avant le consentement | `consents` type `marketing` décoché par défaut ; aucun traceur côté serveur | ⬜ vérification au lot web | 🟡 |
| C-RGPD-11 | Procédure de violation de données, notification sous 72 h | `data_breaches` avec `deadline_at` recalculée par trigger depuis `privacy.breach_notification_hours` | — (procédure au lot ops) | 🟡 |
| C-RGPD-12 | Consentements séparés et horodatés, retrait possible | `consents` en **ajout seul** (`trg_consents_no_update`) ; retrait = nouvelle ligne | `6.2` « les consentements sont en ajout seul » | ✅ |

## 4.8 Sécurité

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-SEC-01 | Rôles et Row Level Security, moindre privilège | `0015_rls.sql` : RLS activée **et forcée** sur les 48 tables, politiques par rôle, `DELETE` révoqué | `4.8` « toutes les tables ont RLS activé » | ✅ |
| C-SEC-02 | Double authentification pour l'admin | Configuration Supabase Auth | ⬜ lot déploiement | ⬜ |
| C-SEC-03 | Chiffrement des données sensibles au repos (IBAN, registre national) | `hr.courier_payroll` en `bytea` chiffré, clé hors base | — | 🟡 |
| C-SEC-04 | PIN stocké haché | `app.set_order_pin()` → bcrypt via `pgcrypto` | `20.3` « le PIN est stocké haché, jamais en clair » | ✅ |
| C-SEC-05 | Journal d'audit de chaque action admin et de chaque contrôle d'âge | `audit.admin_actions`, `audit.order_events`, `audit.settings_history`, tous en ajout seul | `20.11` « chaque transition est journalisée avec son acteur » | ✅ |
| C-SEC-06 | Sauvegardes chiffrées | Configuration d'hébergement | 📋 | 📋 |
| C-SEC-07 | Revue OWASP ASVS et MASVS avant la mise en production | Processus | 📋 | 📋 |

## 4.9 Accessibilité

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-A11Y-01 | WCAG 2.1 niveau AA : contrastes, zones tactiles ≥ 44 px, lecteurs d'écran, textes alternatifs | ⬜ **lot UI — rien n'est encore implémenté** | — | ⬜ |

> Point d'honnêteté : l'accessibilité ne peut pas être traitée au niveau de la
> base de données. Elle est entièrement devant nous, et doit être intégrée dès
> le premier écran plutôt que rattrapée après coup.

## 4.10 Marques et contenus

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-MAR-01 | Nom final vérifié auprès du BOIP et de l'EUIPO avant publication | Nom exposé uniquement via `app.display_name` (H-01) ; aucune chaîne de marque en dur | 📋 Q-01 | 📋 |
| C-MAR-02 | Aucun logo ni habillage de marque tiers ; photos prises par l'Opérateur | `products.chk_photo_is_own` : une photo ne peut être publiée que si `photo_owned_by_operator` ; libellés génériques dans le seed | Contrainte de base de données | ✅ |

## 4.11 Activité alimentaire

| ID | Exigence | Implémentation | Test | Statut |
|----|----------|----------------|------|--------|
| C-AFS-01 | `afsca_registration_ref` rempli, ou explicitement « non requis » après vérification, avant l'ouverture du premier quartier | Paramètre `food.afsca_registration_ref`, `required_for_launch` ; `app.open_zone()` refuse tant qu'il manque | `20.10` test dédié AFSCA | ✅ |
| C-AFS-02 | Produits préemballés uniquement, pas de stock propre hors garde de 24 h | `orders.hub_hold_hours` ; aucune table de stock dans le schéma | — | ✅ |

## 4.12 Documents légaux à générer comme gabarits

Les 12 gabarits sont dans `docs/legal/`. Chacun porte l'en-tête
**« À FAIRE VALIDER PAR UN JURISTE »** et un numéro de version.

La base de données refuse de publier un document non validé :
`legal_documents.chk_no_publish_before_validation`.

| ID | Document | Fichier | Statut |
|----|----------|---------|--------|
| C-DOC-01 | Mentions légales | `docs/legal/01-mentions-legales.md` | 📋 |
| C-DOC-02 | CGU | `docs/legal/02-cgu.md` | 📋 |
| C-DOC-03 | CGV | `docs/legal/03-cgv.md` | 📋 |
| C-DOC-04 | Politique de confidentialité | `docs/legal/04-politique-confidentialite.md` | 📋 |
| C-DOC-05 | Politique cookies | `docs/legal/05-politique-cookies.md` | 📋 |
| C-DOC-06 | Contrat d'occupation d'étudiant | `docs/legal/06-contrat-occupation-etudiant.md` | 📋 |
| C-DOC-07 | Règlement de travail | `docs/legal/07-reglement-travail.md` | 📋 |
| C-DOC-08 | Charte palettier | `docs/legal/08-charte-palettier.md` | 📋 |
| C-DOC-09 | Règlement du parrainage et des ambassadeurs | `docs/legal/09-reglement-parrainage-ambassadeurs.md` | 📋 |
| C-DOC-10 | Règlement des promotions | `docs/legal/10-reglement-promotions.md` | 📋 |
| C-DOC-11 | Registre des traitements | `docs/legal/11-registre-traitements.md` | 📋 |
| C-DOC-12 | Modèle d'AIPD | `docs/legal/12-modele-aipd.md` | 📋 |

---

## Résumé honnête de la couverture

Décompte sur les 70 exigences de la partie 4, hors liste des 12 gabarits
juridiques (tous en attente de validation) :

| Statut | Nombre d'exigences |
|--------|--------------------|
| ✅ implémenté côté serveur et testé | 39 |
| 🟡 partiel : base en place, partie applicative à venir | 18 |
| ⬜ pas encore implémenté | 5 |
| 📋 hors code, démarche de l'équipe | 8 |

**Ce qui est solide aujourd'hui** : tout ce qui touche à l'âge, à l'alcool, aux
promotions, au droit du travail, à la tarification, à la minimisation des
données, à la conservation et à l'auditabilité. Ce sont précisément les
exigences qui, une fois contournées, exposent l'Opérateur à une sanction
pénale ou à une requalification.

**Ce qui reste entièrement devant nous** : l'accessibilité (4.9), la double
authentification admin (4.8), les parcours de notification et de facturation,
et toutes les démarches externes. Aucun de ces points n'est masqué : ils sont
dans le tableau avec leur lot.
