/**
 * Order tracking (spec 6.9 to 6.11).
 *
 * Shows the status timeline, the delivery PIN, the cancellation terms as they
 * stand right now, and — once delivered — the rating. The timeline comes from
 * app.order_timeline, which returns statuses and timestamps only: the audit
 * journal carries actor identities and internal reasons, and stays closed.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner }
  from '../../src/components/ui';
import { api, ApiError, type OrderDetail } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros, palette, typography } from '../../src/theme';

const STATUS_LABELS: Record<string, string> = {
  WAITLISTED: "En attente de l'ouverture du quartier",
  CREATED: 'En attente de paiement',
  PAID: 'Paiement reçu',
  SEARCHING_COURIER: "Recherche d'un palettier",
  COURIER_ASSIGNED: 'Palettier trouvé',
  AT_STORE: 'Au magasin',
  PURCHASED: 'Articles achetés',
  EN_ROUTE: 'En route vers votre kot',
  ARRIVED: 'Arrivé',
  DELIVERED: 'Livré',
  DELIVERY_FAILED: 'Remise impossible',
  HELD_AT_HUB: 'Gardé au local',
  NO_COURIER_FOUND: 'Aucun palettier trouvé',
  CANCELLED_BY_CLIENT: 'Annulé par vous',
  CANCELLED_BY_OPS: "Annulé par l'équipe",
  REFUNDED_PARTIAL: 'Remboursé partiellement',
  REFUNDED_FULL: 'Remboursé intégralement',
};

export default function Suivi() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();

  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState(0);
  const [rated, setRated] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(async () => {
    if (!session.token || !id) return;
    try {
      setDetail(await api.order(session.token, id));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    }
  }, [session.token, id]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Stands in for the provider's authentication page. In the real flow the
   * client is sent to `checkoutUrl`; the simulated provider has no such page.
   */
  async function simulatePayment() {
    if (!session.token || !id) return;
    setSimulating(true);
    try {
      await api.simulatePayment(session.token, id);
      await load();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setSimulating(false);
    }
  }

  async function cancel() {
    if (!session.token || !id) return;
    setBusy(true);
    try {
      await api.cancelOrder(session.token, id, 'annulation depuis le suivi');
      await load();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  async function rate() {
    if (!session.token || !id || score === 0) return;
    setBusy(true);
    try {
      await api.rateOrder(session.token, id, score, []);
      setRated(true);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  if (failure) {
    return (
      <Screen>
        <ErrorBanner message={failure} />
        <Button label="Retour à l'accueil" variant="secondary" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  if (!detail) return <Screen><Loading /></Screen>;

  const { order, items, timeline, cancellationTerms } = detail;
  const isOver = ['DELIVERED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_OPS',
                  'REFUNDED_FULL', 'REFUNDED_PARTIAL'].includes(order.status);

  return (
    <Screen>
      <Title>Commande {order.reference}</Title>
      <Body muted>{STATUS_LABELS[order.status] ?? order.status}</Body>

      <View style={{ height: spacing.lg }} />

      {order.status === 'CREATED' ? (
        <Card tone="notice">
          <Small muted={false}>Paiement en attente</Small>
          <Small>
            Dans l'application réelle, vous seriez redirigé vers Bancontact pour
            l'authentification forte. Sur cet environnement, le prestataire de
            paiement est simulé : rien n'est réellement débité.
          </Small>
          <Button
            label="Simuler l'authentification et le paiement"
            onPress={simulatePayment}
            loading={simulating}
          />
        </Card>
      ) : null}

      <Card>
        <Small muted={false}>Code de remise</Small>
        <Text style={{ ...typography.display, color: palette.primary, letterSpacing: 6 }}>
          ••••
        </Text>
        <Small>
          Le palettier vous le demandera après avoir contrôlé l'âge. Il vous
          sera communiqué par notification à l'arrivée.
        </Small>
      </Card>

      <Card>
        <Small muted={false}>Suivi</Small>
        <View style={{ height: spacing.sm }} />
        {timeline.length === 0
          ? <Small>Aucun événement pour l'instant.</Small>
          : timeline.map((step, index) => (
              <View key={`${step.status}-${index}`} style={{ marginBottom: spacing.sm }}>
                <Row
                  left={STATUS_LABELS[step.status] ?? step.status}
                  right={new Date(step.occurred_at).toLocaleTimeString('fr-BE', {
                    hour: '2-digit', minute: '2-digit',
                  })}
                />
              </View>
            ))}
      </Card>

      <Card>
        <Small muted={false}>Détail</Small>
        <View style={{ height: spacing.sm }} />
        {items.map((item, index) => (
          <Row
            key={index}
            left={`${item.quantity} × ${item.name}`}
            right={euros(item.unit_indicative_price_cents * item.quantity)}
          />
        ))}
        <Divider />
        <Row left="Frais de livraison" right={euros(order.delivery_fee_cents)} />
        <Row left="Frais de service" right={euros(order.service_fee_cents)} />
        <Divider />
        <Row left="Total" right={euros(order.total_estimated_cents)} strong />
      </Card>

      {!isOver ? (
        <Card>
          <Small muted={false}>Annulation</Small>
          <Small>{cancellationTerms.explanation}</Small>
          <Button
            label="Annuler la commande"
            variant={cancellationTerms.free ? 'secondary' : 'danger'}
            onPress={cancel}
            loading={busy}
          />
        </Card>
      ) : null}

      {order.status === 'DELIVERED' && !rated ? (
        <Card>
          <Small muted={false}>Comment s'est passée la livraison ?</Small>
          <View style={{ height: spacing.sm }} />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {[1, 2, 3, 4, 5].map(value => (
              <View key={value} style={{ flex: 1 }}>
                <Button
                  label={String(value)}
                  variant={score === value ? 'primary' : 'secondary'}
                  onPress={() => setScore(value)}
                  accessibilityHint={`Noter ${value} sur 5`}
                />
              </View>
            ))}
          </View>
          <Button label="Envoyer la note" onPress={rate} disabled={score === 0} loading={busy} />
          <Small>
            Les notes ne sont jamais modifiées ni filtrées. Elles servent au
            suivi qualité, jamais à sanctionner automatiquement un palettier.
          </Small>
        </Card>
      ) : null}

      {rated ? (
        <Card tone="success">
          <Body>Merci, votre note a été enregistrée.</Body>
        </Card>
      ) : null}

      <Button label="Retour à l'accueil" variant="ghost" onPress={() => router.replace('/')} />
    </Screen>
  );
}
