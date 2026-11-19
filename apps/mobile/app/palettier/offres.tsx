/**
 * Mission offers (spec 7.5).
 *
 * The offer shows what the specification requires and nothing more: items,
 * weight, store, floor, distance, estimated bonus. The client's address
 * appears only once the mission is accepted — the server does not send it
 * before that.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Loading, ErrorBanner, Field }
  from '../../src/components/ui';
import { courierApi, ApiError, type MissionOffer } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros } from '../../src/theme';

export default function Offres() {
  const router = useRouter();
  const session = useSession();

  const [offers, setOffers] = useState<MissionOffer[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session.token) return;
    try {
      setOffers((await courierApi.offers(session.token)).offers);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    }
  }, [session.token]);

  useEffect(() => { void load(); }, [load]);

  async function accept(offer: MissionOffer) {
    if (!session.token) return;
    setBusy(offer.offerId);
    setFailure(null);
    try {
      await courierApi.acceptOffer(session.token, offer.offerId);
      router.replace('/palettier/mission');
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function decline(offer: MissionOffer) {
    if (!session.token) return;
    setBusy(offer.offerId);
    try {
      const result = await courierApi.declineOffer(
        session.token, offer.offerId, reason.trim() || undefined);
      setNote(result.message);
      setDeclining(null);
      setReason('');
      await load();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(null);
    }
  }

  if (!offers) return <Screen><Loading /></Screen>;

  return (
    <Screen>
      <Title>Missions proposées</Title>

      {failure ? <ErrorBanner message={failure} /> : null}
      {note ? <Card tone="success"><Body>{note}</Body></Card> : null}

      {offers.length === 0 ? (
        <Card>
          <Body>Aucune mission proposée pour l'instant.</Body>
          <Small>
            Les missions arrivent pendant ton créneau. Tu es payé pour ce temps
            d'attente.
          </Small>
        </Card>
      ) : null}

      {offers.map(offer => (
        <Card key={offer.offerId}>
          <Row left={offer.storeName} right={euros(offer.estimatedBonusCents)} strong />
          <Small>Prime estimée pour cette mission</Small>

          <View style={{ height: spacing.sm }} />

          <Row left="Articles" right={String(offer.itemCount)} />
          <Row left="Poids total" right={`${offer.totalWeightKg.toFixed(1)} kg`} />
          <Row left="Étage" right={offer.hasLift
            ? `${offer.floor} (ascenseur)` : `${offer.floor} (sans ascenseur)`} />
          {offer.distanceM !== null ? (
            <Row left="Distance au magasin" right={`${Math.round(offer.distanceM)} m`} />
          ) : null}

          <View style={{ height: spacing.sm }} />

          {declining === offer.offerId ? (
            <>
              <Field
                label="Motif (facultatif)"
                value={reason}
                onChangeText={setReason}
                hint="Il sert au suivi qualité. Refuser n'entraîne aucune sanction."
              />
              <Button label="Confirmer le refus" variant="secondary"
                      onPress={() => decline(offer)} loading={busy === offer.offerId} />
              <Button label="Annuler" variant="ghost" onPress={() => setDeclining(null)} />
            </>
          ) : (
            <>
              <Button label="Accepter" onPress={() => accept(offer)}
                      loading={busy === offer.offerId} />
              <Button label="Refuser" variant="secondary"
                      onPress={() => setDeclining(offer.offerId)} />
            </>
          )}
        </Card>
      ))}

      <Card>
        <Small>
          L'adresse exacte du client ne t'est communiquée qu'une fois la
          mission acceptée.
        </Small>
      </Card>

      <Button label="Retour" variant="ghost" onPress={() => router.replace('/palettier')} />
    </Screen>
  );
}
