> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Conditions générales d'utilisation (CGU)

**Objet.** Régir l'accès au service et l'usage des comptes, distinctement des conditions de vente.

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## 1. Objet et acceptation

Les présentes CGU régissent l'accès à l'application et son utilisation. Leur
acceptation est **obligatoire, distincte de celle des CGV, et horodatée**
(`consents.consent_type = 'tos'`). La version acceptée par chaque utilisateur
est conservée.

## 2. Conditions d'inscription

- Âge minimum : `{{ alcohol.min_age_beer_wine }}` ans. **Une personne de moins
  de 16 ans ne peut pas s'inscrire** (contrainte `chk_under_16_never_active`).
- Vérification d'identité par un prestataire agréé. Seules la **tranche d'âge**,
  la date et la méthode de vérification sont conservées : jamais d'image, de
  copie de pièce d'identité ni de date de naissance (C-RGPD-03).
- Adresse située dans la zone de service. Une adresse hors zone est refusée.

## 3. Zone de service et liste d'attente

Le service ouvre quartier par quartier. Tant qu'un quartier n'est pas ouvert,
aucune commande ne peut être passée ni payée : l'utilisateur rejoint une liste
d'attente et n'est notifié que s'il a consenti aux notifications.

## 4. Compte utilisateur

Sections à rédiger : unicité du compte, confidentialité des identifiants,
exactitude des informations, interdiction du partage de compte.

⚖️ **Décision juridique.** Rédaction des clauses de suspension et de résiliation.
Rappel de contrainte produit : **aucun blocage de compte n'est automatique**
(`client_blocks.decided_by` est obligatoire) et toute décision est motivée et
contestable (C-TRA-10, C-CON-08).

## 5. Comportement attendu

À rédiger : respect des palettiers, exactitude de l'adresse, présence à la
remise, interdiction de commander pour un mineur.

## 6. Modification des CGU

À rédiger : préavis, nouvelle acceptation, conservation des versions.

## 7. Droit applicable

Droit belge. ⚖️ Clause attributive de juridiction à faire valider (consommateurs).
