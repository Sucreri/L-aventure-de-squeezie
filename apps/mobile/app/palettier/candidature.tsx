import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Field, Card, ErrorBanner, Row }
  from '../../src/components/ui';
import { courierApi, ApiError } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing } from '../../src/theme';

/** Capacities come from the server; shown here so the choice is informed. */
const TRANSPORTS = [
  { value: 'foot_trolley', label: 'À pied avec un diable', hint: 'Environ 3 unités par trajet' },
  { value: 'bike_trailer', label: 'Vélo avec remorque', hint: 'Environ 4 unités par trajet' },
  { value: 'cargo_bike', label: 'Vélo-cargo', hint: 'Environ 6 unités par trajet' },
] as const;

export default function Candidature() {
  const router = useRouter();
  const session = useSession();

  const [transport, setTransport] = useState<string>('');
  const [proof, setProof] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!session.token) return;
    if (!transport) { setFailure('Choisis ton moyen de transport.'); return; }
    if (!proof.trim()) { setFailure("Ton attestation d'inscription est nécessaire."); return; }

    setBusy(true);
    setFailure(null);

    try {
      await courierApi.apply(session.token, {
        transport, enrolmentProofRef: proof.trim(),
      });
      router.replace('/palettier/formation');
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Devenir palettier</Title>
      <Body muted>
        Tu seras salarié sous contrat d'occupation d'étudiant, payé à l'heure,
        avec une prime par livraison et 100 % des pourboires.
      </Body>

      <View style={{ height: spacing.lg }} />

      {failure ? <ErrorBanner message={failure} /> : null}

      <Card>
        <Small muted={false}>Conditions</Small>
        <View style={{ height: spacing.sm }} />
        <Row left="Âge minimum" right="18 ans" />
        <Row left="Statut" right="Étudiant inscrit" />
        <Row left="Quota annuel" right="650 h à cotisations réduites" />
      </Card>

      <Small muted={false}>Ton moyen de transport</Small>
      <Small>
        Il détermine ce que tu peux porter en une fois. Tu pourras le changer
        plus tard.
      </Small>
      <View style={{ height: spacing.sm }} />

      {TRANSPORTS.map(option => (
        <Card key={option.value} tone={transport === option.value ? 'success' : 'default'}>
          <Body>{option.label}</Body>
          <Small>{option.hint}</Small>
          <Button
            label={transport === option.value ? 'Choisi' : 'Choisir'}
            variant={transport === option.value ? 'primary' : 'secondary'}
            onPress={() => setTransport(option.value)}
            accessibilityHint={option.hint}
          />
        </Card>
      ))}

      <View style={{ height: spacing.md }} />

      <Field
        label="Attestation d'inscription"
        value={proof}
        onChangeText={setProof}
        hint="La référence de ton attestation d'inscription dans ton établissement."
      />

      <Card>
        <Small>
          Les données nécessaires à la paie, dont ton numéro de registre
          national, sont transmises au secrétariat social. Elles sont chiffrées
          et accessibles au seul rôle RH : l'équipe produit ne les voit pas.
        </Small>
      </Card>

      <Button label="Déposer ma candidature" onPress={submit} loading={busy} />
    </Screen>
  );
}
