> # ⚠️ À FAIRE VALIDER PAR UN JURISTE
>
> Ce document est un **gabarit**, pas un texte juridique définitif
> (règle §0.4 du cahier des charges). Il ne doit pas être publié tel quel.
> La base de données refuse d'ailleurs de le publier tant que
> `legal_documents.validated_by_lawyer` est faux.
>
> **Version du gabarit : 0.1** · Dernière modification : 2026-11-17

# Charte du palettier

**Objet.** Rappeler, en langage clair, les règles de terrain qui engagent la responsabilité du palettier et de l'Opérateur.

**Convention de lecture.** Les éléments entre `{{ }}` sont des **paramètres**
lus depuis `app_settings` (règle §0.3 : rien n'est codé en dur). Les blocs
« ⚖️ Décision juridique » marquent un point que seul un juriste tranche ; ils
renvoient aux questions ouvertes de `HYPOTHESES.md`.

> Ce document complète le contrat et le règlement de travail ; il ne les
> remplace pas. En cas de contradiction, le contrat et le règlement priment.

## 1. Avant de commencer

- Ton contrat doit être signé et ta Dimona confirmée. Sans les deux,
  l'application ne te proposera aucune mission.
- Tu dois avoir réussi le quiz de formation obligatoire.
- Tu réserves tes créneaux à l'avance et tu peux les annuler selon les règles
  affichées.

## 2. Alcool : la règle la plus importante

Tu es la dernière personne entre un produit alcoolisé et quelqu'un qui n'a
peut-être pas l'âge. **Tu dois refuser la remise** dans trois cas :

1. l'âge n'est pas prouvé ;
2. la personne n'a pas l'âge requis ;
3. la personne est **manifestement ivre**.

Comment faire : tu regardes la pièce d'identité, tu saisis l'année de
naissance dans l'app — **elle n'est pas enregistrée**, l'app calcule seulement
si l'âge suffit — puis tu coches « Pièce vérifiée, personne en état normal ».
Tu ne photographies jamais une pièce d'identité.

**Un refus ne te sera jamais reproché.** Aucune sanction automatique n'existe.
Les refus sont visibles par l'équipe uniquement pour du suivi qualité.

## 3. Le code PIN

Le PIN n'est demandé **qu'après** le contrôle d'âge. Sans contrôle d'âge validé
et sans PIN correct, la commande ne peut pas être marquée comme livrée :
l'application te bloquera.

## 4. Pendant la mission

- Tu achètes avec la carte de dépense de l'Opérateur, jamais avec ton argent.
- Tu photographies le ticket. Si le montant lu est faux, tu le corriges.
- Si un article manque, tu suis la règle de remplacement choisie par le client.
  Il a `{{ orders.substitution_response_s }}` secondes pour répondre, sinon sa
  règle par défaut s'applique.
- Si le ticket dépasse l'estimation de plus de
  `{{ pricing.operator_absorbs_gap_cents }}`, tu dois obtenir l'accord du client
  dans l'app **avant** de payer.

## 5. Sécurité

- Maximum `{{ courier.max_hand_carried_pallets }}` palettes à la main par trajet.
- Un bouton d'aide te met en contact direct avec l'équipe.
- Tu peux mettre ta mission en pause.
- Ta position n'est partagée que pendant un créneau réservé, jamais en dehors.

## 6. Tes droits

- Tu es **salarié**, pas indépendant. Tu es payé à l'heure, même quand tu
  attends.
- Tu as droit à une explication écrite du fonctionnement de l'attribution des
  missions, consultable à tout moment.
- Aucune décision importante te concernant n'est automatique : une personne la
  prend, la motive, et tu peux la contester.
- 100 % des pourboires te reviennent.
