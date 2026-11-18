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
      </Stack>
    </SessionProvider>
  );
}
