> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Règlement du parrainage et du programme ambassadeurs

**Objet.** Encadrer les mécanismes de recommandation et leurs récompenses (§8).

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## 1. Parrainage client

- Chaque client dispose d'un code personnel.
- La récompense (`{{ growth.referral_reward_deliveries }}` livraison(s) offerte(s)
  au parrain et au filleul) est acquise **après la première commande livrée du
  filleul**, et non à l'inscription.
- Plafond : `{{ growth.referral_monthly_cap }}` parrainages récompensés par mois.
- **Anti-fraude** : un parrainage est bloqué en cas de même téléphone, même
  appareil ou même moyen de paiement qu'un parrainage antérieur du même parrain.
  L'auto-parrainage est impossible.

⚖️ **Décision juridique.** Qualification de la récompense (avantage commercial
ou réduction) et traitement comptable.

> **Contrainte produit absolue.** Une récompense de parrainage ne peut jamais
> prendre la forme d'alcool offert, d'une réduction sur un produit alcoolisé ou
> d'un avantage lié à une quantité d'alcool. Le moteur de promotions refuse
> structurellement toute règle de ce type.

## 2. Codes partenaires (cercles, kots-à-projet)

Codes nommés attribués à une organisation, sans propriétaire individuel, suivis
en back-office. Les contreparties éventuelles sont à définir par convention.

⚖️ **Décision juridique.** Une contrepartie financière versée à un cercle
étudiant soulève des questions de qualification et de publicité pour l'alcool si
le cercle communique sur le service. À examiner spécifiquement.

## 3. Programme ambassadeurs

- Code personnel, tableau de bord des filleuls actifs.
- Récompense par filleul ayant reçu une première livraison.
- Mode de récompense : `{{ growth.ambassador_reward_mode }}` (crédit ou
  rémunération).

⚖️ **Décision juridique bloquante (Q-06).** Si la récompense est une
**rémunération**, l'ambassadeur peut être requalifié en travailleur ou en
apporteur d'affaires, avec des obligations sociales et fiscales. Un **crédit
commercial non convertible en argent** est l'option la plus prudente et reste
la valeur par défaut tant que la question n'est pas tranchée.

## 4. Communication des ambassadeurs

Un ambassadeur qui communique publiquement sur le service est soumis aux mêmes
règles que l'Opérateur : pas de mise en avant de l'alcool sur un réseau sans
contrôle d'âge, pas d'association entre alcool et performance ou excès, pas de
ciblage des mineurs.
