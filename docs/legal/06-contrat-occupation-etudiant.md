> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Contrat d'occupation d'étudiant

**Objet.** Encadrer la relation de travail salarié entre l'Opérateur et le palettier étudiant (§4.3).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

> ⚠️ **Avertissement renforcé.** Ce gabarit ne remplace en aucun cas le modèle
> fourni par le **secrétariat social** ou l'agence d'intérim. Le contrat
> d'occupation d'étudiant est un contrat écrit réglementé : forme, mentions
> obligatoires et délais de remise sont fixés par la loi. Le modèle officiel
> prévaut sur ce document en toute circonstance.

## 1. Parties

Employeur : `{{ operator.legal_name }}`, BCE `{{ operator.bce_number }}`,
`{{ operator.address }}`. Travailleur : à compléter.

## 2. Mentions obligatoires à faire figurer

À compléter avec le secrétariat social : date de début et de fin, lieu
d'exécution, description des fonctions, durée de travail, rémunération,
commission paritaire, délai de préavis, lieu d'hébergement le cas échéant.

## 3. Fonction

Courses et livraison à Louvain-la-Neuve : achat de produits préemballés en
magasin pour le compte de clients, transport et remise à domicile, contrôle de
l'âge à la remise des produits alcoolisés.

## 4. Rémunération

| Élément | Paramètre |
|---------|-----------|
| Salaire horaire brut | `{{ pay.hourly_wage_cents }}` |
| Commission paritaire | `{{ pay.joint_committee_ref }}` |
| Prime par livraison | `{{ pay.bonus_per_delivery_cents }}` |
| Prime par étage sans ascenseur | `{{ pay.bonus_per_floor_cents }}` |
| Pourboires | `{{ pay.tips_share_to_courier }}` reversés au palettier |

⚖️ **Décisions juridiques bloquantes.**
- Commission paritaire applicable et barème exact (Q-04). **L'application
  n'invente aucune valeur par défaut** : tant que ce paramètre est vide, aucun
  créneau ne peut être publié.
- Régime social et fiscal des primes et des pourboires (Q-05).

## 5. Temps de travail

Les heures comptent du début du créneau réservé à sa fin, ou à la fin de la
dernière mission si elle déborde. Durées maximales : `{{ work.max_hours_per_day }}` h
par jour, `{{ work.max_hours_per_week }}` h par semaine, avec un repos minimal de
`{{ work.min_rest_between_shifts_h }}` h entre deux créneaux.

**Travail de nuit.** Aucun créneau ne se termine après
`{{ work.service_end_time }}`. Tout créneau dépassant
`{{ work.night_work_threshold_time }}` requiert une dérogation validée par le
secrétariat social, cochée en back-office et journalisée (Q-11).

## 6. Quota étudiant

Le travailleur est informé du quota annuel de `{{ work.annual_quota_hours }}`
heures à cotisations réduites et peut le consulter dans l'application. Une
alerte apparaît à partir de `{{ work.quota_alert_threshold_hours }}` heures.

## 7. Obligations de l'employeur

Déclaration Dimona avant toute prestation ; assurance accidents du travail
(`{{ labour.work_accident_insurance_ref }}`) ; affiliation à un service externe
de prévention (`{{ labour.prevention_service_ref }}`) ; remise du règlement de
travail (`{{ labour.work_rules_document_id }}`).

**Garantie technique.** L'application bloque l'ouverture de tout créneau tant
que ces références ne sont pas renseignées, et refuse toute mission à un
palettier dont le contrat n'est pas signé ou la Dimona non confirmée.

## 8. Géolocalisation

Activée uniquement pendant un créneau réservé, pour l'attribution des missions
et le suivi client. Le travailleur est informé de la finalité et de la durée de
conservation (`{{ retention.courier_positions_days }}` jours). Son consentement
est recueilli séparément.

## 9. Systèmes automatisés

Conformément à la directive (UE) 2024/2831, le travailleur reçoit une
**explication écrite du système d'attribution des missions**, disponible à tout
moment dans l'application. Aucune décision qui le concerne n'est prise
automatiquement : refuser une mission n'entraîne aucune sanction automatique, et
toute décision importante fait l'objet d'une revue humaine motivée et
contestable.
