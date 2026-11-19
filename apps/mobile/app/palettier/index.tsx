/**
 * Courier home.
 *
 * One screen that answers "what do I do now?", whatever stage the courier is
 * at: still applying, waiting on a Dimona confirmation, free between shifts,
 * holding an offer, or mid-mission.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner }
  from '../../src/components/ui';
import { courierApi, ApiError, type OnboardingStatus, type MissionOffer, type GuidedMission }
  from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros } from '../../src/theme';

export default function CourierHome() {
  const router = useRouter();
  const session = useSession();

  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [offers, setOffers] = useState<MissionOffer[]>([]);
  const [mission, setMission] = useState<GuidedMission | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session.token) return;
    try {
      const me = await courierApi.me(session.token);
      setOnboarding(me.onboarding);

      if (me.onboarding.canWork) {
        const [o, m] = await Promise.all([
          courierApi.offers(session.token),
          courierApi.mission(session.token),
        ]);
        setOffers(o.offers);
        setMission(m.mission ? m : null);
      }
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    }
  }, [session.token]);

  useEffect(() => { void load(); }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (!session.token) {
    return (
      <Screen>
        <Title>Devenir palettier</Title>
        <Body muted>Connecte-toi d'abord pour déposer ta candidature.</Body>
        <Button label="Créer un compte" onPress={() => router.push('/inscription')} />
      </Screen>
    );
  }

  if (failure) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!onboarding) return <Screen><Loading /></Screen>;

  return (
    <Screen>
      <Title>Espace palettier</Title>

      {!onboarding.canWork ? (
        <Card tone="notice">
          <Small muted={false}>Prochaine étape</Small>
          <Body>{onboarding.nextStep}</Body>
          <View style={{ height: spacing.sm }} />

          {!onboarding.applied ? (
            <Button label="Déposer ma candidature"
                    onPress={() => router.push('/palettier/candidature')} />
          ) : !onboarding.trainingPassed ? (
            <Button label="Passer la formation"
                    onPress={() => router.push('/palettier/formation')} />
          ) : !onboarding.contractSigned ? (
            <Button label="Voir et signer mon contrat"
                    onPress={() => router.push('/palettier/contrat')} />
          ) : (
            <Small>
              Ta déclaration Dimona doit être confirmée par l'équipe avant ta
              première prestation. C'est une obligation légale, pas une
              formalité : aucune mission ne peut t'être attribuée avant.
            </Small>
          )}
        </Card>
      ) : null}

      <Card>
        <Small muted={false}>Où tu en es</Small>
        <View style={{ height: spacing.sm }} />
        <Row left="Candidature" right={onboarding.applied ? '✓' : '—'} />
        <Row left="Formation obligatoire" right={onboarding.trainingPassed ? '✓' : '—'} />
        <Row left="Contrat signé" right={onboarding.contractSigned ? '✓' : '—'} />
        <Row left="Dimona confirmée" right={onboarding.dimonaConfirmed ? '✓' : '—'} />
      </Card>

      {mission?.mission ? (
        <Card tone="success">
          <Small muted={false}>Mission en cours</Small>
          <Body>{mission.instruction}</Body>
          <Button label="Reprendre ma mission"
                  onPress={() => router.push('/palettier/mission')} />
        </Card>
      ) : null}

      {offers.length > 0 ? (
        <Card tone="notice">
          <Small muted={false}>
            {offers.length === 1 ? 'Une mission te est proposée' : `${offers.length} missions proposées`}
          </Small>
          {offers.slice(0, 1).map(offer => (
            <View key={offer.offerId}>
              <Row left={offer.storeName} right={euros(offer.estimatedBonusCents)} strong />
              <Small>
                {offer.itemCount} article{offer.itemCount > 1 ? 's' : ''} ·{' '}
                {offer.totalWeightKg.toFixed(1)} kg · étage {offer.floor}
                {offer.hasLift ? ' avec ascenseur' : ' sans ascenseur'}
              </Small>
            </View>
          ))}
          <Button label="Voir les offres" onPress={() => router.push('/palettier/offres')} />
        </Card>
      ) : null}

      {onboarding.canWork ? (
        <>
          <Divider />
          <Button label="Mes créneaux" variant="secondary"
                  onPress={() => router.push('/palettier/creneaux')} />
          <Button label="Mes heures et mes gains" variant="secondary"
                  onPress={() => router.push('/palettier/gains')} />
        </>
      ) : null}

      <Divider />

      <Card>
        <Small muted={false}>Tes droits</Small>
        <View style={{ height: spacing.sm }} />
        <Small>
          Tu es salarié, pas indépendant : tu es payé à l'heure, même quand tu
          attends. Refuser une mission n'entraîne aucune sanction. Aucune
          décision importante te concernant n'est prise automatiquement.
        </Small>
      </Card>

      <Button label="Retour à l'accueil" variant="ghost" onPress={() => router.replace('/')} />
    </Screen>
  );
}
