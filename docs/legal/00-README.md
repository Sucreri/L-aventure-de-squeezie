# Gabarits juridiques

Les 12 documents exigés par le §4.12 du cahier des charges.

**Aucun n'est un texte juridique définitif.** Chacun porte l'en-tête
« À FAIRE VALIDER PAR UN JURISTE » et un numéro de version, conformément à la
règle §0.4 : *« Tu ne rédiges jamais de texte juridique définitif. »*

Ces fichiers servent à trois choses :

1. **donner au juriste une base de travail structurée**, plutôt qu'une page
   blanche, en pointant précisément les décisions qui lui reviennent ;
2. **relier chaque clause au paramètre technique correspondant**, pour qu'un
   changement de règle juridique se traduise par un changement de paramètre et
   non par une modification de code ;
3. **documenter ce que le code garantit déjà**, afin que le juriste sache ce
   qu'il n'a pas besoin de couvrir par une simple promesse contractuelle.

| # | Document | Qui valide |
|---|----------|------------|
| 01 | Mentions légales | Juriste |
| 02 | CGU | Juriste |
| 03 | CGV | Juriste |
| 04 | Politique de confidentialité | Juriste / DPO |
| 05 | Politique cookies | Juriste / DPO |
| 06 | Contrat d'occupation d'étudiant | **Secrétariat social** (modèle officiel) |
| 07 | Règlement de travail | **Secrétariat social** |
| 08 | Charte palettier | Juriste (complément, non substitut) |
| 09 | Règlement parrainage et ambassadeurs | Juriste + comptable |
| 10 | Règlement des promotions | Juriste |
| 11 | Registre des traitements | DPO |
| 12 | Modèle d'AIPD | DPO |

## Garantie technique

`legal_documents` comporte la contrainte `chk_no_publish_before_validation` :
un document ne peut pas recevoir de date de publication tant que
`validated_by_lawyer` est faux. Publier un gabarit non validé est donc refusé
par la base de données, et pas seulement déconseillé.
