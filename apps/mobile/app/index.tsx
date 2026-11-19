/**
 * Home.
 *
 * Shows the operator's identity and the public neighbourhood gauge before
 * anything else: spec 4.6 requires the operator to be identifiable before any
 * order, and spec 8.1 makes the gauge the whole acquisition mechanism.
 */

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner }
  from '../src/components/ui';
import { api, type ZoneProgress } from '../src/api';
import { useSession, usePublicSettings } from '../src/session';
import { spacing, palette } from '../src/theme';

export default function Home() {
  const router = useRouter();
  const session = useSession();
  const settings = usePublicSettings();

  const [zones, setZones] = useState<ZoneProgress[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.zones()
      .then(result => setZones(result.zones))
      .catch(e => setError(e.message));
  }, []);

  if (error) {
    return <Screen><ErrorBanner message={error} /></Screen>;
  }

  if (!settings || !zones) {
    return <Screen><Loading /></Screen>;
  }

  const openZones = zones.filter(z => z.status === 'open');

  return (
    <Screen>
      <Title>{settings.appName}</Title>
      <Body muted>
        Des boissons et des snacks livrés depuis les supermarchés de
        Louvain-la-Neuve jusqu'à la porte de votre kot.
      </Body>

      <View style={{ height: spacing.xl }} />

      {session.token ? (
        <>
          <Button label="Commander" onPress={() => router.push('/adresse')} />
          <Button label="Mon compte" variant="secondary" onPress={() => router.push('/compte')} />
        </>
      ) : (
        <>
          <Button label="Créer un compte" onPress={() => router.push('/inscription')} />
          <Small>
            L'inscription est réservée aux personnes de {settings.minAgeBeerWine} ans et plus.
          </Small>
        </>
      )}

      <Divider style={{ marginVertical: spacing.xl }} />

      <Title level={2}>Où nous livrons</Title>
      <Body muted>
        Nous ouvrons quartier par quartier. Un quartier ouvre quand assez de
        voisins et de palettiers s'y sont inscrits.
      </Body>

      <View style={{ height: spacing.md }} />

      {zones.map(zone => (
        <Card key={zone.slug} tone={zone.status === 'open' ? 'success' : 'default'}>
          <Row left={zone.name} right={zone.status === 'open' ? 'Ouvert' : "Liste d'attente"} strong />

          {zone.status === 'open' ? (
            <Small muted={false}>Le service est disponible dans ce quartier.</Small>
          ) : (
            <>
              <View style={{ height: spacing.sm }} />
              <Gauge
                label="Voisins inscrits"
                current={Number(zone.clients_waiting)}
                target={zone.client_threshold}
              />
              <Gauge
                label="Palettiers inscrits"
                current={Number(zone.couriers_waiting)}
                target={zone.courier_threshold}
              />
            </>
          )}
        </Card>
      ))}

      {openZones.length === 0 ? (
        <Card tone="notice">
          <Body>
            Aucun quartier n'est encore ouvert. Inscrivez-vous pour être prévenu
            dès l'ouverture du vôtre.
          </Body>
        </Card>
      ) : null}

      <Divider style={{ marginVertical: spacing.xl }} />

      <Title level={2}>Devenir palettier</Title>
      <Body muted>
        Étudiant, salarié, payé à l'heure même quand tu attends, avec 100 % des
        pourboires. Tu choisis tes créneaux.
      </Body>
      <Button label="En savoir plus" variant="secondary"
              onPress={() => router.push('/palettier')} />

      <Divider style={{ marginVertical: spacing.xl }} />

      <Title level={3}>Qui vend</Title>
      <Small muted={false}>{settings.operator.legalName}</Small>
      <Small>{settings.operator.address}</Small>
      <Small>BCE {settings.operator.bceNumber} · TVA {settings.operator.vatNumber}</Small>
      <Small>{settings.operator.contactEmail}</Small>

      <View style={{ height: spacing.md }} />
      <Small>{settings.healthWarning}</Small>
    </Screen>
  );
}

/**
 * The public gauge of spec 8.1 ("Biéreau : 78/150").
 * The figure is written out as well as drawn: a bar alone would carry the
 * meaning in shape only.
 */
function Gauge({ label, current, target }: { label: string; current: number; target: number }) {
  const ratio = Math.min(current / target, 1);

  return (
    <View
      style={{ marginTop: spacing.sm }}
      accessibilityRole="progressbar"
      accessibilityLabel={`${label} : ${current} sur ${target}`}
      accessibilityValue={{ min: 0, max: target, now: current }}
    >
      <Row left={label} right={`${current} / ${target}`} />
      <View style={{
        height: 10, borderRadius: 5, backgroundColor: palette.border,
        overflow: 'hidden', marginTop: spacing.xs,
      }}>
        <View style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: palette.primary }} />
      </View>
    </View>
  );
}
