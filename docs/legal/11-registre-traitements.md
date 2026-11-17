> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Registre des traitements

**Objet.** Registre prévu par l'article 30 du RGPD (§4.7).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## Identité du responsable

`{{ operator.legal_name }}` · BCE `{{ operator.bce_number }}` ·
`{{ operator.address }}` · contact : `{{ privacy.dpo_contact_email }}`

---

## T-01 — Gestion des comptes clients

| Rubrique | Contenu |
|----------|---------|
| Finalité | Création et gestion du compte, authentification |
| Base légale | Exécution du contrat (art. 6.1.b) |
| Personnes | Clients |
| Catégories de données | Identité, contact, tranche d'âge, statut |
| Destinataires | Hébergeur, prestataire SMS/e-mail |
| Transferts hors UE | Aucun |
| Conservation | Suppression après `{{ retention.inactive_accounts_months }}` mois d'inactivité, préavis de `{{ retention.inactive_notice_days }}` jours |
| Mesures de sécurité | RLS, chiffrement en transit et au repos, journal d'audit |

## T-02 — Vérification de l'âge

| Rubrique | Contenu |
|----------|---------|
| Finalité | Respect de l'interdiction de vente d'alcool aux mineurs |
| Base légale | Obligation légale (art. 6.1.c) |
| Catégories de données | **Tranche d'âge, booléen vérifié, méthode, horodatage. Rien d'autre.** Ni date de naissance, ni image, ni numéro de document. |
| Destinataires | Prestataire de vérification d'identité |
| Conservation | Durée du compte |
| Mesures particulières | Minimisation garantie par le schéma : aucune colonne ne peut accueillir ces données |

## T-03 — Commandes et livraison

Finalité : exécution de la commande. Base légale : contrat. Données : adresse,
panier, statuts, PIN haché. Conservation : durée légale comptable.

## T-04 — Contrôle d'âge à la remise

Finalité : obligation légale. Données : résultat, motif, horodatage, palettier.
**Jamais l'année saisie, jamais une photo.** Conservation : à déterminer avec le
juriste, en cohérence avec la prescription des infractions.

## T-05 — Géolocalisation des palettiers

| Rubrique | Contenu |
|----------|---------|
| Finalité | Attribution des missions, suivi client |
| Base légale | Exécution du contrat de travail, information claire du travailleur |
| Personnes | Palettiers |
| Conservation | `{{ retention.courier_positions_days }}` jours, purge automatique journalisée |
| Mesure particulière | Collecte **techniquement impossible** hors créneau réservé |
| AIPD | **Requise** — voir `12-modele-aipd.md` |

## T-06 — Paie

Finalité : obligation légale. Données : IBAN, numéro de registre national,
heures, primes. **Chiffrées au repos, accessibles au seul rôle RH, chaque accès
journalisé avec sa finalité.** Destinataire : secrétariat social.

## T-07 — Paiements et facturation

Finalité : exécution du contrat et obligation comptable. **Aucune donnée de
carte n'est conservée** (tokenisation chez le prestataire).

## T-08 — Communications marketing

Base légale : **consentement**, décoché par défaut, retirable à tout moment.
Fréquence plafonnée à `{{ growth.marketing_push_max_per_week }}` par semaine.

## T-09 — Liste d'attente

Base légale : intérêt légitime (à valider). Conservation :
`{{ retention.waitlist_never_opened_months }}` mois si jamais activée.

## T-10 — Support, incidents et réclamations

Base légale : exécution du contrat et intérêt légitime. Données : messages,
photos d'incident. Chat conservé `{{ retention.chat_messages_months }}` mois.

---

⚖️ **À compléter par le juriste** : validation de chaque base légale, durées de
conservation des traitements T-04 et T-10, liste définitive des sous-traitants
et de leurs DPA.
