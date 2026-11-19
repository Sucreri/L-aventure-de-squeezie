import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../src/session';
import { palette } from '../src/theme';

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.surface },
          headerTintColor: palette.ink,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: palette.surfaceAlt },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Palette' }} />
        <Stack.Screen name="inscription" options={{ title: 'Créer un compte' }} />
        <Stack.Screen name="verification" options={{ title: "Vérification d'âge" }} />
        <Stack.Screen name="consentements" options={{ title: 'Vos choix' }} />
        <Stack.Screen name="adresse" options={{ title: 'Votre kot' }} />
        <Stack.Screen name="catalogue" options={{ title: 'Catalogue' }} />
        <Stack.Screen name="panier" options={{ title: 'Panier' }} />
        <Stack.Screen name="recapitulatif" options={{ title: 'Récapitulatif' }} />
        <Stack.Screen name="compte" options={{ title: 'Mon compte' }} />
        <Stack.Screen name="commande/[id]" options={{ title: 'Suivi' }} />
        <Stack.Screen name="palettier/index" options={{ title: 'Palettier' }} />
        <Stack.Screen name="palettier/candidature" options={{ title: 'Candidature' }} />
        <Stack.Screen name="palettier/formation" options={{ title: 'Formation' }} />
        <Stack.Screen name="palettier/contrat" options={{ title: 'Contrat' }} />
        <Stack.Screen name="palettier/creneaux" options={{ title: 'Créneaux' }} />
        <Stack.Screen name="palettier/offres" options={{ title: 'Missions' }} />
        <Stack.Screen name="palettier/mission" options={{ title: 'Mission' }} />
        <Stack.Screen name="palettier/gains" options={{ title: 'Gains' }} />
      </Stack>
    </SessionProvider>
  );
}
