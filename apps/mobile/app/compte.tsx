/**
 * Account and data rights (spec 6.13, 4.6, 4.7).
 *
 * Export and deletion are one press each. Spec 4.6 forbids dark patterns:
 * leaving is as simple as joining, with no retention flow and no guilt.
 */

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner }
  from '../src/components/ui';
import { api, ApiError } from '../src/api';
import { useSession } from '../src/session';
import { spacing } from '../src/theme';

const CONSENT_LABELS: Record<string, string> = {
  tos: "Conditions générales d'utilisation",
  sales_terms: 'Conditions générales de vente',
  privacy: 'Politique de confidentialité',
  marketing: 'Notifications',
  geolocation: 'Position pour pré-remplir une adresse',
};

export default function Compte() {
  const router = useRouter();
  const session = useSession();

  const [profile, setProfile] = useState<Awaited<ReturnType<typeof api.me>> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);
  const [deletion, setDeletion] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!session.token) return;
    api.me(session.token)
      .then(setProfile)
      .catch(e => setFailure(e.message));
  }, [session.token]);

  async function exportData() {
    if (!session.token) return;
    setBusy(true);
    try {
      await api.exportMyData(session.token);
      setExported(true);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (!session.token) return;
    setBusy(true);
    try {
      const result = await api.deleteMyAccount(session.token);
      setDeletion(result.message);
      if (result.status === 'completed') {
        session.signOut();
      }
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  if (!session.token) {
    return (
      <Screen>
        <Title>Mon compte</Title>
        <Body muted>Vous n'êtes pas connecté.</Body>
        <Button label="Retour à l'accueil" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  if (failure) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!profile) return <Screen><Loading /></Screen>;

  return (
    <Screen>
      <Title>Mon compte</Title>

      <Card>
        <Row left="Nom" right={`${profile.user.first_name} ${profile.user.last_name}`} />
        <Row left="E-mail" right={profile.user.email ?? '—'} />
        <Row
          left="Tranche d'âge"
          right={profile.user.age_bracket === 'b18_plus' ? '18 ans et plus'
               : profile.user.age_bracket === 'b16_17' ? '16–17 ans' : '—'}
        />
        <Divider />
        <Small>
          Votre date de naissance n'est pas conservée : seule la tranche ci-dessus
          l'est, avec la date et la méthode de vérification.
        </Small>
      </Card>

      <Card>
        <Small muted={false}>Vos consentements</Small>
        <View style={{ height: spacing.sm }} />
        {profile.consents.map(consent => (
          <Row
            key={consent.consent_type}
            left={CONSENT_LABELS[consent.consent_type] ?? consent.consent_type}
            right={consent.granted ? 'Accepté' : 'Refusé'}
          />
        ))}
        <Divider />
        <Small>
          Un retrait de consentement n'efface pas l'historique : il ajoute une
          nouvelle décision horodatée, afin que l'on puisse toujours établir ce
          qui a été accepté et quand.
        </Small>
      </Card>

      <Card>
        <Small muted={false}>Vos données</Small>
        <View style={{ height: spacing.sm }} />
        <Body>
          Vous pouvez à tout moment récupérer une copie de vos données ou
          supprimer votre compte. Les deux se font ici, sans passer par le
          support.
        </Body>

        <Button label="Exporter mes données" variant="secondary"
                onPress={exportData} loading={busy} />
        {exported ? <Small muted={false}>Export généré.</Small> : null}
      </Card>

      <Card tone={confirmDelete ? 'danger' : 'default'}>
        <Small muted={false}>Supprimer mon compte</Small>
        <View style={{ height: spacing.sm }} />

        {deletion ? (
          <Body>{deletion}</Body>
        ) : confirmDelete ? (
          <>
            <Body>
              Cette action est définitive. Vos factures sont conservées le temps
              légal imposé à toute entreprise, mais votre compte est anonymisé.
            </Body>
            <Button label="Confirmer la suppression" variant="danger"
                    onPress={deleteAccount} loading={busy} />
            <Button label="Annuler" variant="ghost" onPress={() => setConfirmDelete(false)} />
          </>
        ) : (
          <Button label="Supprimer mon compte" variant="secondary"
                  onPress={() => setConfirmDelete(true)} />
        )}
      </Card>

      <Button label="Retour à l'accueil" variant="ghost" onPress={() => router.replace('/')} />
    </Screen>
  );
}
