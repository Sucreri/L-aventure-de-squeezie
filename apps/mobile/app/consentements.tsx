/**
 * Consents (spec 6.2).
 *
 * Each one is collected separately, and the optional ones are unticked by
 * default. There is no "accept everything" shortcut, because that is precisely
 * the dark pattern spec 4.6 forbids.
 */

import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Checkbox, Card, ErrorBanner, Divider }
  from '../src/components/ui';
import { api, ApiError } from '../src/api';
import { useSession } from '../src/session';
import { spacing } from '../src/theme';

export default function Consentements() {
  const router = useRouter();
  const session = useSession();

  const [tos, setTos] = useState(false);
  const [salesTerms, setSalesTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  // Optional, and unticked by default (spec 6.2, HYPOTHESES.md H-08).
  const [marketing, setMarketing] = useState(false);
  const [geolocation, setGeolocation] = useState(false);

  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mandatoryAccepted = tos && salesTerms && privacy;

  async function submit() {
    if (!session.token) return;
    setBusy(true);
    setFailure(null);

    try {
      await api.recordConsents(session.token, [
        { type: 'tos', granted: tos },
        { type: 'sales_terms', granted: salesTerms },
        { type: 'privacy', granted: privacy },
        { type: 'marketing', granted: marketing },
        { type: 'geolocation', granted: geolocation },
      ]);
      router.push('/adresse');
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Vos choix</Title>
      <Body muted>
        Chaque case est distincte. Vous pouvez revenir sur les choix facultatifs
        à tout moment depuis votre compte.
      </Body>

      <View style={{ height: spacing.lg }} />

      {failure ? <ErrorBanner message={failure} /> : null}

      <Card>
        <Small muted={false}>Nécessaires pour commander</Small>
        <View style={{ height: spacing.sm }} />

        <Checkbox
          required
          label="J'accepte les conditions générales d'utilisation"
          description="Elles régissent l'accès au service et l'usage de votre compte."
          checked={tos}
          onToggle={setTos}
        />
        <Checkbox
          required
          label="J'accepte les conditions générales de vente"
          description="Prix, livraison, annulation et remboursement. La version acceptée est conservée."
          checked={salesTerms}
          onToggle={setSalesTerms}
        />
        <Checkbox
          required
          label="J'ai pris connaissance de la politique de confidentialité"
          description="Ce que nous collectons, pourquoi, combien de temps, et vos droits."
          checked={privacy}
          onToggle={setPrivacy}
        />
      </Card>

      <Divider />

      <Card>
        <Small muted={false}>Facultatifs</Small>
        <View style={{ height: spacing.sm }} />

        <Checkbox
          label="Me prévenir quand mon quartier ouvre"
          description="Sans cette case, nous ne vous enverrons aucune notification, y compris à l'ouverture."
          checked={marketing}
          onToggle={setMarketing}
        />
        <Checkbox
          label="Utiliser ma position pour pré-remplir mon adresse"
          description="Uniquement au moment où vous saisissez une adresse. Jamais en arrière-plan."
          checked={geolocation}
          onToggle={setGeolocation}
        />
      </Card>

      <Button
        label="Continuer"
        onPress={submit}
        disabled={!mandatoryAccepted}
        loading={busy}
        accessibilityHint={mandatoryAccepted
          ? undefined
          : 'Les trois cases nécessaires doivent être cochées.'}
      />

      {!mandatoryAccepted ? (
        <Small>Les trois premières cases sont nécessaires pour pouvoir commander.</Small>
      ) : null}
    </Screen>
  );
}
