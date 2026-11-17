> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Modèle d'analyse d'impact (AIPD)

**Objet.** Préparer l'analyse d'impact exigée avant le lancement, pour la géolocalisation des travailleurs et la vérification d'âge (§4.7).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

> Cette AIPD doit être **menée et signée avant l'ouverture du premier
> quartier**. Ce gabarit en prépare la structure ; il ne la remplace pas.

## 1. Pourquoi une AIPD est requise

Deux traitements la rendent nécessaire :

1. **la géolocalisation systématique de travailleurs** pendant leur temps de
   travail ;
2. **la vérification d'âge à grande échelle**, qui touche un public en partie
   mineur (16-17 ans) et conditionne l'accès à un produit réglementé.

## 2. Description systématique

À compléter : nature, portée, contexte et finalités, en s'appuyant sur le
registre des traitements (T-02, T-04, T-05).

## 3. Nécessité et proportionnalité

Points à argumenter, avec les mesures déjà en place :

| Risque | Mesure déjà implémentée |
|--------|-------------------------|
| Surveillance excessive des travailleurs | Collecte **impossible** hors créneau réservé (contrainte serveur) ; purge après `{{ retention.courier_positions_days }}` jours ; consentement distinct ; information claire |
| Conservation de données d'identité | **Aucune colonne** ne peut accueillir une date de naissance ou une image de pièce d'identité ; seule la tranche d'âge est conservée |
| Décisions automatisées défavorables | Aucune sanction automatique ; toute décision importante fait l'objet d'une revue humaine motivée ; explication écrite du système d'attribution disponible |
| Accès indu aux données de paie | Schéma `hr` isolé, non exposé à l'API, accès par fonction vérifiant le rôle et journalisant la finalité |
| Réidentification par recoupement | Minimisation ; positions purgées ; journaux sans données personnelles |

## 4. Évaluation des risques pour les personnes

À compléter : gravité et vraisemblance, pour chacun des risques ci-dessus, du
point de vue **des personnes concernées** et non de l'organisation.

## 5. Mesures complémentaires envisagées

À compléter. Pistes : réduction supplémentaire de la fréquence des positions
hors mission active, anonymisation plus précoce des trajets, information
renforcée au premier créneau.

## 6. Consultation

- Consultation des travailleurs ou de leurs représentants : à organiser.
- Consultation de l'Autorité de protection des données : requise uniquement si
  un risque résiduel élevé subsiste après mesures.

## 7. Conclusion et signature

Avis du DPO ou du conseil, décision du responsable du traitement, date, nom et
signature. **Tant que cette section est vide, le lancement ne peut pas avoir
lieu.**
