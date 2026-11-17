> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Mentions légales

**Objet.** Identifier l'Opérateur de façon complète et vérifiable, avant toute commande (§4.6).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## 1. Éditeur du service

| Élément | Valeur | Paramètre |
|---------|--------|-----------|
| Dénomination sociale | `{{ operator.legal_name }}` | obligatoire au lancement |
| Forme juridique | Société à responsabilité limitée (SRL) de droit belge | — |
| Siège social | `{{ operator.address }}` | obligatoire au lancement |
| Numéro d'entreprise (BCE) | `{{ operator.bce_number }}` | obligatoire au lancement |
| Numéro de TVA | `{{ operator.vat_number }}` | obligatoire au lancement |
| Adresse e-mail | `{{ operator.contact_email }}` | obligatoire au lancement |
| Téléphone | `{{ operator.contact_phone }}` | obligatoire au lancement |
| Représentant légal | À compléter | — |

> Aucun quartier ne peut ouvrir tant que ces paramètres sont vides :
> `app.open_zone()` refuse l'ouverture et `app.launch_blockers()` les liste.

## 2. Hébergement

Hébergeur, siège et région de traitement : à compléter. **Contrainte
impérative** : région de l'Union européenne (H-17, C-RGPD-07).

## 3. Activité

`{{ app.display_name }}` est un service de courses et de livraison. L'Opérateur
achète en magasin, pour le compte du client, des produits préemballés qu'il lui
refacture **au prix exact du ticket de caisse, sans marge**, et facture
séparément des frais de livraison et de service.

⚖️ **Décision juridique.** Qualification exacte de cette prestation et régime
TVA de la refacturation (débours au sens de l'article 28, 5° du Code de la TVA,
ou achat-revente). Voir `HYPOTHESES.md` Q-03.

## 4. Enregistrement AFSCA

`{{ food.afsca_registration_ref }}` — ou la mention « non requis » après
vérification auprès de l'AFSCA (Q-07).

## 5. Vente d'alcool

Le service propose des boissons contenant de l'alcool. Leur vente est réservée
aux personnes de `{{ alcohol.min_age_beer_wine }}` ans et plus. L'âge est
vérifié à l'inscription, à la commande et à la remise.

`{{ alcohol.health_warning_fr }}`

## 6. Règlement des litiges

Service de médiation pour le consommateur : `{{ consumer.mediation_service_contact }}`.
Plateforme européenne de règlement en ligne des litiges : à compléter.

## 7. Propriété intellectuelle

⚖️ **Décision juridique.** Le nom `{{ app.display_name }}` est provisoire et
doit faire l'objet d'une recherche d'antériorité BOIP et EUIPO avant
publication (Q-01, C-MAR-01). Aucun logo ou habillage de marque tiers
n'apparaît dans le service (C-MAR-02).
