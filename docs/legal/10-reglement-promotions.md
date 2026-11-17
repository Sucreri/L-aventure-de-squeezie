> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Règlement des promotions

**Objet.** Fixer ce qu'une promotion peut et ne peut pas être, et le rendre opposable.

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

## 1. Règle fondamentale

**Une promotion ne peut porter que sur les frais de livraison ou les frais de
service. Jamais sur un produit.**

Cette règle n'est pas une consigne interne : elle est **imposée par la structure
de la base de données**. Le type `promotion_target` ne comporte que deux
valeurs, `delivery_fee` et `service_fee`, et aucune colonne ne permet de
désigner un produit. Une promotion portant sur un article est donc
techniquement impossible, pas seulement interdite.

## 2. Interdictions explicites

Conformément à la Convention belge en matière de publicité et de
commercialisation des boissons contenant de l'alcool et au droit belge :

- aucune réduction sur un produit alcoolisé ;
- aucun alcool offert, à aucun titre ;
- aucune réduction liée à la **quantité** d'alcool achetée — ce qui exclut les
  formules du type « deux palettes achetées, la livraison offerte » ;
- aucun ciblage des moins de 18 ans par une communication mentionnant l'alcool.

**Mise en œuvre technique.** Les conditions d'une promotion passent par une
**liste blanche** : seules `min_order_cents`, `modes`, `zone_ids`,
`first_order_only`, `valid_weekdays` et `max_per_user` sont acceptées. Toute
autre clé est refusée par le serveur. Une seconde barrière refuse en outre toute
condition dont le texte évoque un produit ou l'alcool.

## 3. Transparence

Toute promotion affiche sa durée, son périmètre, son plafond d'utilisation et
ses conditions avant l'engagement du client. Le prix total après réduction est
affiché avant paiement.

## 4. Coefficient d'affluence

Le coefficient d'affluence n'est pas une promotion mais un élément du prix. Il
est borné entre `{{ pricing.surge_min }}` et `{{ pricing.surge_max }}`,
identique pour tous les clients d'une zone au même instant, **jamais
personnalisé**, et annoncé avant paiement.

## 5. Validation

⚖️ **Décision juridique.** Chaque visuel promotionnel doit être relu au regard
de la Convention alcool avant diffusion, même lorsque la promotion ne porte que
sur les frais, car le visuel lui-même peut constituer une communication sur
l'alcool.
