-- =============================================================================
-- 0016_service_settings.sql
-- Parameters the orchestration layer needs. Added as a new migration rather
-- than edited into 0002, because 0002 has already been published.
-- =============================================================================

insert into app_settings (key, value, value_type, category, description, required_for_launch) values

-- Spec 7.6: the till amount is read automatically but stays correctable. Below
-- this confidence the courier must confirm the amount by hand before paying.
('receipts.ocr_min_confidence', '0.90', 'decimal', 'orders',
 'Confiance minimale de la lecture automatique du ticket ; en dessous, saisie manuelle obligatoire', false),

-- Spec 6.8: where the client comes back after strong customer authentication.
('checkout.return_url_template', '"palette://checkout/{orderId}"', 'text', 'orders',
 'URL de retour après authentification forte', false),

-- Spec 15: how long an order waits for a courier before the client may cancel
-- free of charge is already cancellation.no_courier_timeout_s; this is how
-- often the dispatcher re-runs while searching.
('dispatch.retry_interval_s', '20', 'duration_s', 'dispatch',
 'Intervalle entre deux tentatives d''attribution tant qu''aucun palettier n''a accepté', false);
