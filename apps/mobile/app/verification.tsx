/**
 * Age verification (spec 6.1).
 *
 * The screen is explicit about what leaves and what comes back, because this
 * is the step where people reasonably worry about handing over an identity
 * document. What comes back is a bracket. Nothing else is stored — and the
 * system has no column in which to store anything else.
 */

import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, ErrorBanner, Loading }
  from '../src/components/ui';
import { api, ApiError } from '../src/api';
import { useSession } from '../src/session';
import { spacing } from '../src/theme';

export default function Verification() {
  const router = useRouter();
  const session = useSession();

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  if (!session.token) {
    return (
      <Screen>
        <ErrorBanner message="Votre session a expiré. Recommencez l'inscription." />
        <Button label="Retour" variant="secondary" onPress={() => router.replace('/inscription')} />
      </Screen>
    );
  }

  async function verify() {
    setBusy(true);
    setFailure(null);
    setRefused(null);

    try {
      const started = await api.startVerification(session.token!);
      // In production the person is redirected to the provider here. The
      // simulated provider answers straight away.
      const result = await api.completeVerification(session.token!, started.sessionId);

      if (!result.verified) {
        setRefused(result.reason ?? "La vérification n'a pas abouti.");
        return;
      }

      router.push('/consentements');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setRefused(error.message);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  if (busy) return <Screen><Loading label="Vérification en cours…" /></Screen>;

  return (
    <Screen>
      <Title>Vérifier votre âge</Title>
      <Body muted>
        La loi belge interdit la vente d'alcool aux mineurs. Nous vérifions
        votre âge une fois, auprès d'un prestataire agréé.
      </Body>

      <View style={{ height: spacing.lg }} />

      {failure ? <ErrorBanner message={failure} /> : null}

      {refused ? (
        <Card tone="danger">
          <Body>{refused}</Body>
          <View style={{ height: spacing.sm }} />
          <Small>
            Si vous pensez qu'il s'agit d'une erreur, écrivez au support : nous
            réexaminons chaque cas à la main.
          </Small>
        </Card>
      ) : null}

      <Card>
        <Small muted={false}>Ce qui est conservé</Small>
        <View style={{ height: spacing.sm }} />
        <Body>· Votre tranche d'âge : 16–17 ans, ou 18 ans et plus.</Body>
        <Body>· La date et la méthode de la vérification.</Body>
        <View style={{ height: spacing.md }} />
        <Small muted={false}>Ce qui ne l'est jamais</Small>
        <View style={{ height: spacing.sm }} />
        <Body>· Votre date de naissance.</Body>
        <Body>· Une image ou une copie de votre pièce d'identité.</Body>
        <Body>· Votre numéro de document.</Body>
      </Card>

      <Button label="Vérifier mon âge" onPress={verify} />
    </Screen>
  );
}
