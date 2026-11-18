import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Field, ErrorBanner, Card }
  from '../src/components/ui';
import { api, ApiError } from '../src/api';
import { useSession, usePublicSettings } from '../src/session';
import { spacing } from '../src/theme';

export default function Inscription() {
  const router = useRouter();
  const session = useSession();
  const settings = usePublicSettings();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const next: Record<string, string> = {};
    if (!firstName.trim()) next['firstName'] = 'Votre prénom est nécessaire.';
    if (!lastName.trim()) next['lastName'] = 'Votre nom est nécessaire.';
    if (!email.trim()) next['email'] = 'Une adresse e-mail est nécessaire.';
    else if (!email.includes('@')) next['email'] = "Cette adresse e-mail n'est pas valide.";

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    setFailure(null);

    try {
      const result = await api.register({
        firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(),
      });
      session.signIn(result.token, result.userId);
      router.push('/verification');
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Créer un compte</Title>
      <Body muted>
        Nous avons besoin de votre nom pour que le palettier sache à qui remettre
        la commande.
      </Body>

      <View style={{ height: spacing.xl }} />

      {failure ? <ErrorBanner message={failure} /> : null}

      <Field label="Prénom" value={firstName} onChangeText={setFirstName}
             error={errors['firstName']} autoCapitalize="words" />
      <Field label="Nom" value={lastName} onChangeText={setLastName}
             error={errors['lastName']} autoCapitalize="words" />
      <Field label="Adresse e-mail" value={email} onChangeText={setEmail}
             error={errors['email']} keyboardType="email-address" autoCapitalize="none"
             hint="Elle sert à vous envoyer la confirmation de commande et le reçu." />

      <Button label="Continuer" onPress={submit} loading={busy} />

      <View style={{ height: spacing.lg }} />

      <Card>
        <Small muted={false}>Ce que nous ne conservons jamais</Small>
        <View style={{ height: spacing.xs }} />
        <Small>
          Votre date de naissance n'est jamais enregistrée : seule votre tranche
          d'âge l'est. Aucune photo ni copie de pièce d'identité n'est conservée,
          à aucun moment.
        </Small>
      </Card>

      {settings ? (
        <Small>
          L'inscription est réservée aux personnes de {settings.minAgeBeerWine} ans
          et plus.
        </Small>
      ) : null}
    </Screen>
  );
}
