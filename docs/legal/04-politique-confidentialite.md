> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Politique de confidentialité

**Objet.** Informer les personnes concernées des traitements, de leurs bases légales, des durées de conservation et de leurs droits (RGPD, §4.7).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## 1. Responsable du traitement

`{{ operator.legal_name }}`, `{{ operator.address }}`, BCE `{{ operator.bce_number }}`.
Contact dédié aux droits des personnes : `{{ privacy.dpo_contact_email }}`.

⚖️ **Décision juridique.** Désignation d'un DPO obligatoire ou non, au vu de la
géolocalisation de travailleurs et de la vérification d'âge à grande échelle.

## 2. Ce que nous ne collectons jamais

Ce point mérite d'être affirmé en premier, car il est **garanti par la
structure même de la base de données**, et pas seulement par une promesse :

- aucune **date de naissance** n'est conservée, seulement une tranche d'âge ;
- aucune **image ni copie de pièce d'identité** n'est conservée, à aucun moment ;
- lors du contrôle à la remise, **l'année saisie par le palettier n'est pas
  enregistrée** : seuls le résultat, le motif, l'horodatage et l'identité du
  palettier le sont ;
- aucune **donnée de carte bancaire** n'est conservée par l'Opérateur.

Les tables concernées ne comportent aucune colonne capable d'accueillir ces
données, et un test automatisé le vérifie à chaque exécution de la suite.

## 3. Traitements

| Finalité | Données | Base légale | Conservation |
|----------|---------|-------------|--------------|
| Création et gestion du compte | Identité, contact, tranche d'âge | Exécution du contrat | `{{ retention.inactive_accounts_months }}` mois d'inactivité |
| Vérification de l'âge | Résultat, méthode, horodatage | Obligation légale (vente d'alcool) | Durée du compte |
| Commandes et livraison | Adresse, panier, statuts | Exécution du contrat | Durée légale comptable |
| Facturation et comptabilité | Factures, paiements | Obligation légale | Durée légale comptable |
| Géolocalisation des palettiers | Position pendant un créneau réservé | Exécution du contrat de travail | `{{ retention.courier_positions_days }}` jours |
| Chat de commande | Messages | Exécution du contrat | `{{ retention.chat_messages_months }}` mois |
| Paie | IBAN, registre national | Obligation légale | Durée légale sociale |
| Liste d'attente | Compte, quartier | Intérêt légitime | `{{ retention.waitlist_never_opened_months }}` mois si jamais activée |
| Communications marketing | Contact, préférences | **Consentement** | Jusqu'au retrait |

⚖️ **Décision juridique.** Validation de chaque base légale, en particulier
l'intérêt légitime invoqué pour la liste d'attente.

## 4. Destinataires et sous-traitants

Hébergeur, prestataire de paiement, prestataire de vérification d'identité,
émetteur des cartes de dépense, secrétariat social, prestataire SMS,
cartographie. Un contrat de sous-traitance (DPA) est conclu avec chacun (Q-15).
Hébergement dans l'Union européenne.

## 5. Vos droits

Accès, rectification, effacement, portabilité, limitation, opposition, retrait
du consentement. **L'export et la suppression du compte se font en
libre-service dans l'application**, en une seule action, sans passer par le
support. Réclamation possible auprès de l'Autorité de protection des données.

## 6. Violation de données

Détection, journalisation, notification à l'Autorité dans les
`{{ privacy.breach_notification_hours }}` heures lorsque c'est requis.
