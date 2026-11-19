import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Loading, ErrorBanner, Divider }
  from '../../src/components/ui';
import { courierApi, ApiError, type CourierShift } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros } from '../../src/theme';

function slot(startsAt: string, endsAt: string): string {
  const from = new Date(startsAt);
  const to = new Date(endsAt);
  const day = from.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  const time = (d: Date) => d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time(from)} – ${time(to)}`;
}

export default function Creneaux() {
  const router = useRouter();
  const session = useSession();

  const [shifts, setShifts] = useState<CourierShift[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session.token) return;
    try {
      setShifts((await courierApi.shifts(session.token)).shifts);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    }
  }, [session.token]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(shift: CourierShift) {
    if (!session.token) return;
    setBusy(shift.id);
    setFailure(null);
    try {
      if (shift.bookedByMe) {
        await courierApi.cancelShift(session.token, shift.id);
      } else {
        await courierApi.bookShift(session.token, shift.id);
      }
      await load();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(null);
    }
  }

  if (failure && !shifts) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!shifts) return <Screen><Loading /></Screen>;

  return (
    <Screen>
      <Title>Créneaux</Title>
      <Body muted>
        Tu es payé pour toute la durée du créneau que tu réserves, même quand
        aucune mission n'arrive.
      </Body>

      <View style={{ height: spacing.lg }} />

      {failure ? <ErrorBanner message={failure} /> : null}

      {shifts.length === 0 ? (
        <Card>
          <Body>Aucun créneau publié pour l'instant.</Body>
          <Small>
            Les créneaux sont publiés par l'équipe en fonction de la demande,
            quartier par quartier.
          </Small>
        </Card>
      ) : null}

      {shifts.map(shift => (
        <Card key={shift.id} tone={shift.bookedByMe ? 'success' : 'default'}>
          <Row left={shift.zoneName}
               right={`${shift.taken} / ${shift.places} places`} strong />
          <Small muted={false}>{slot(shift.startsAt, shift.endsAt)}</Small>

          {shift.peakBonusCents > 0 ? (
            <Small>Prime de créneau de pointe : {euros(shift.peakBonusCents)}</Small>
          ) : null}

          {shift.nightDerogation ? (
            <Small>
              Créneau en soirée, couvert par une dérogation validée par le
              secrétariat social.
            </Small>
          ) : null}

          <Button
            label={shift.bookedByMe ? 'Annuler ma réservation' : 'Réserver'}
            variant={shift.bookedByMe ? 'secondary' : 'primary'}
            onPress={() => toggle(shift)}
            loading={busy === shift.id}
            disabled={!shift.bookedByMe && shift.taken >= shift.places}
          />
        </Card>
      ))}

      <Divider />
      <Button label="Retour" variant="ghost" onPress={() => router.replace('/palettier')} />
    </Screen>
  );
}
