> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Conditions générales de vente (CGV)

**Objet.** Régir la commande, le prix, le paiement, la livraison, l'annulation et le remboursement (§4.6).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## 1. Modèle économique

L'Opérateur agit comme **mandataire du client pour l'achat** des produits en
magasin, puis comme prestataire de livraison. Les produits sont refacturés au
**prix exact du ticket de caisse**, sans marge. La rémunération de l'Opérateur
est constituée des seuls frais de livraison et de service.

⚖️ **Décision juridique.** Qualification du mandat d'achat pour compte d'autrui
et régime TVA associé (Q-03).

## 2. Prix

| Élément | Paramètre |
|---------|-----------|
| Frais de base (1re palette ou commande sans palette) | `{{ pricing.base_fee_cents }}` |
| Par palette supplémentaire | `{{ pricing.extra_pallet_fee_cents }}` |
| Étage sans ascenseur, par étage | `{{ pricing.floor_fee_no_lift_cents }}` |
| Étage avec ascenseur, forfait | `{{ pricing.floor_fee_with_lift_cents }}` |
| Frais de service | `{{ pricing.service_fee_cents }}` |
| Coefficient d'affluence | entre `{{ pricing.surge_min }}` et `{{ pricing.surge_max }}` |
| Réduction « Tournée groupée » | `{{ pricing.grouped_round_discount }}` |

Le **prix total TTC, tous frais compris**, est affiché avant l'engagement. Le
coefficient d'affluence est annoncé clairement, identique pour tous les clients
d'une zone au même instant, et **jamais personnalisé**.

Aucune promotion ne porte sur un produit alcoolisé, ni sur une quantité
d'alcool : les réductions ne peuvent concerner que les frais.

## 3. Écart entre prix indicatif et ticket de caisse

Le prix affiché par article est **indicatif**. Le client est facturé au prix
réel du ticket :

- ticket inférieur à l'estimation : la différence est **remboursée
  automatiquement** ;
- ticket supérieur : l'Opérateur absorbe jusqu'à
  `{{ pricing.operator_absorbs_gap_cents }}` ; au-delà, l'accord explicite du
  client est demandé dans l'application avant tout débit complémentaire.

## 4. Paiement

Bancontact, carte, Apple Pay ou Google Pay, via un prestataire agréé, avec
authentification forte. Aucune donnée de carte n'est conservée par l'Opérateur.
Le paiement en espèces n'existe pas.

## 5. Livraison

Modes : Express, Planifiée (jusqu'à 7 jours), Tournée groupée. Remise à la
porte du kot ou à l'étage selon l'option choisie.

**Remise de produits alcoolisés.** Le palettier contrôle la pièce d'identité de
la personne qui réceptionne et refuse la remise si l'âge n'est pas prouvé, si la
personne n'a pas l'âge requis, ou si elle est manifestement ivre. Ce refus
n'ouvre droit à aucun remboursement des frais engagés.

⚖️ **Décision juridique.** Rédaction exacte de cette clause et de ses
conséquences financières pour le client.

## 6. Annulation

- Gratuite jusqu'à l'achat des articles en magasin inclus.
- Après l'achat : les articles restent dus, ainsi que
  `{{ cancellation.fee_share_after_purchase }}` des frais de livraison.
- Aucun palettier trouvé après `{{ cancellation.no_courier_timeout_s }}` :
  annulation sans frais, remboursement intégral automatique.

Ces conditions sont affichées **avant** le paiement.

## 7. Échec de remise

Les articles sont gardés `{{ orders.hub_hold_hours }}` heures au local de
l'Opérateur. Le client peut les retirer sur présentation d'une pièce d'identité
ou demander une nouvelle livraison payante. Les frais initiaux restent dus.

⚖️ **Décision juridique.** Sort des articles non réclamés au terme du délai
(Q-09), et adresse du local (Q-10).

## 8. Droit de rétractation

`{{ consumer.withdrawal_policy_text }}`

⚖️ **Décision juridique bloquante.** Applicabilité du droit de rétractation et
exceptions retenues (biens périssables, service pleinement exécuté). Q-08.

## 9. Réclamations

Procédure dans l'application. Service de médiation pour le consommateur :
`{{ consumer.mediation_service_contact }}`.
