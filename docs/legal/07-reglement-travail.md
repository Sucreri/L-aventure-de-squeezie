> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Règlement de travail

**Objet.** Document obligatoire remis à chaque travailleur salarié.

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

> ⚠️ Le règlement de travail est un document **obligatoire et réglementé**, à
> établir avec le secrétariat social et à déposer auprès du Contrôle des lois
> sociales. Ce gabarit ne sert qu'à préparer la discussion.

## Sections à établir avec le secrétariat social

1. Horaires de travail et modalités de réservation des créneaux
2. Modes de mesure et de contrôle du temps de travail
3. Rémunération : périodicité, mode de paiement, éléments variables
4. Durée des congés et modalités
5. Délais de préavis, motifs graves de rupture
6. Droits et devoirs du personnel de surveillance
7. Sanctions, amendes et recours
8. Prévention et sécurité : port de charges, sécurité à vélo, conduite à tenir
   en cas d'accident
9. Service externe de prévention : `{{ labour.prevention_service_ref }}`
10. Assurance accidents du travail : `{{ labour.work_accident_insurance_ref }}`
11. Personnes de confiance et procédure en matière de harcèlement
12. Protection des données des travailleurs, géolocalisation comprise
13. Systèmes automatisés d'attribution et droit à l'explication

## Points spécifiques à ce service

- **Port de charges** : maximum `{{ courier.max_hand_carried_pallets }}` palettes
  portées à la main par trajet. Au-delà, un diable ou une remorque est
  obligatoire. Capacités : à pied avec diable `{{ courier.capacity_foot_trolley }}`
  unités, vélo avec remorque `{{ courier.capacity_bike_trailer }}`, vélo-cargo
  `{{ courier.capacity_cargo_bike }}`.
- **Travail de nuit** : interdit en principe au-delà de
  `{{ work.night_work_threshold_time }}` sans dérogation validée.
- **Cartes de dépense** : le palettier n'avance jamais son propre argent.
  Plafond par mission `{{ courier.spend_card_ceiling_cents }}`.
- **Refus de remise** : refuser une remise pour un motif légal n'entraîne
  aucune sanction. C'est une obligation, pas un choix.
