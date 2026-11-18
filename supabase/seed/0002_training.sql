-- =============================================================================
-- 0002_training.sql — the mandatory training quiz (§7.2)
--
-- The questions cover exactly what the specification lists: legal ages,
-- refusing when someone is visibly intoxicated, checking an identity document
-- without copying it, carrying loads, bike safety, conduct.
--
-- They are seeded rather than hard-coded because they state Belgian law and
-- safety rules, both of which change without the app changing.
-- =============================================================================

begin;

update app_settings
   set value = to_jsonb('DÉMO — support joignable au +32 000 00 00 00'::text)
 where key = 'courier.help_contact';

insert into training_questions (topic, prompt, choices, correct_index, explanation, display_rank) values

('legal_age',
 'À partir de quel âge une personne peut-elle légalement recevoir de la bière en Belgique ?',
 '["14 ans", "16 ans", "18 ans", "21 ans"]'::jsonb, 1,
 'La bière et le vin sont autorisés à partir de 16 ans. Les spiritueux, eux, à partir de 18 ans — '
 'et ils ne font pas partie du catalogue.', 10),

('legal_age',
 'Le client a 19 ans, mais c''est son colocataire de 15 ans qui ouvre la porte. Que fais-tu ?',
 '["Je remets la commande : c''est le client qui a payé",
   "Je remets la commande si le colocataire me montre une pièce d''identité",
   "Je refuse la remise : la personne qui réceptionne n''a pas l''âge requis",
   "J''appelle le client et je remets si il me le confirme au téléphone"]'::jsonb, 2,
 'Le contrôle porte sur la personne qui réceptionne physiquement, pas sur celle qui a payé. '
 'Sans l''âge requis à la porte, la remise est refusée.', 20),

('refusal',
 'La personne qui réceptionne est manifestement ivre. Que fais-tu ?',
 '["Je remets quand même : elle a payé",
   "Je refuse la remise et je l''enregistre dans l''app",
   "Je laisse la commande devant la porte",
   "Je remets si quelqu''un d''autre est présent dans le kot"]'::jsonb, 1,
 'Remettre de l''alcool à une personne manifestement ivre est interdit. Tu refuses, tu '
 'l''enregistres, et cela ne t''est jamais reproché.', 30),

('refusal',
 'Tu refuses une remise pour un motif légal. Quelle conséquence pour toi ?',
 '["Une pénalité sur ma note",
   "Moins de missions proposées ensuite",
   "Aucune sanction : c''est une obligation, pas un choix",
   "Une retenue sur ma prime de livraison"]'::jsonb, 2,
 'Aucune sanction automatique n''existe. Les refus sont visibles par l''équipe uniquement pour '
 'du suivi qualité.', 40),

('id_check',
 'Comment vérifies-tu l''âge à la remise ?',
 '["Je photographie la carte d''identité",
   "Je note la date de naissance dans l''app",
   "Je regarde la pièce, je saisis l''année de naissance, et l''app me dit si l''âge suffit",
   "Je demande simplement l''âge à la personne"]'::jsonb, 2,
 'L''année saisie n''est jamais enregistrée : l''app calcule localement et ne conserve que le '
 'résultat. Photographier ou copier une pièce d''identité est interdit.', 50),

('id_check',
 'Quand l''app te demande-t-elle le code PIN ?',
 '["Avant le contrôle d''âge, pour gagner du temps",
   "Après le contrôle d''âge uniquement",
   "À la place du contrôle d''âge",
   "Seulement si le client le propose"]'::jsonb, 1,
 'Le PIN vient après le contrôle d''âge. Sans contrôle validé puis PIN correct, l''app refuse '
 'de marquer la commande livrée.', 60),

('load',
 'Combien de palettes peux-tu porter à la main sur un même trajet ?',
 '["1", "2", "4", "Autant que je peux soulever"]'::jsonb, 1,
 'Deux palettes maximum à la main, soit environ 25 kg en 50 cl. Au-delà, un diable ou une '
 'remorque est obligatoire.', 70),

('bike_safety',
 'Tu livres de nuit à vélo avec une remorque chargée. Quelle est la bonne pratique ?',
 '["Rouler sur le trottoir, c''est plus sûr",
   "Éclairage avant et arrière allumés, charge arrimée, vitesse adaptée au poids",
   "Tenir la remorque d''une main dans les virages",
   "Retirer les réflecteurs qui gênent le chargement"]'::jsonb, 1,
 'Une remorque chargée allonge la distance de freinage et déséquilibre dans les virages. '
 'Éclairage, arrimage et vitesse adaptée.', 80),

('conduct',
 'Un client conteste ton refus de remise et s''énerve. Que fais-tu ?',
 '["Je discute jusqu''à ce qu''il comprenne",
   "Je cède pour éviter le conflit",
   "Je reste calme, je rappelle la règle, j''utilise le bouton d''aide si nécessaire",
   "Je pars sans rien dire et je ne signale rien"]'::jsonb, 2,
 'Le bouton d''aide te met en contact direct avec l''équipe. Un incident signalé est traité par '
 'une personne, pas par un algorithme.', 90),

('conduct',
 'Quand ta position est-elle partagée ?',
 '["En permanence, dès que l''app est installée",
   "Uniquement pendant un créneau que tu as réservé",
   "Pendant 24 h après chaque livraison",
   "Seulement quand un client la demande"]'::jsonb, 1,
 'La géolocalisation n''est active que pendant un créneau réservé, et les positions sont '
 'effacées après 30 jours.', 100);

commit;

select count(*) || ' questions de formation' from training_questions where active;
