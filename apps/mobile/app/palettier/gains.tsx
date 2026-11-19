import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner }
  from '../../src/components/ui';
import { courierApi, type EarningsSummary } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros, palette } from '../../src/theme';

export default function Gains() {
  const router = useRouter();
  const session = useSession();

  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!session.token) return;
    courierApi.earnings(session.token, 30)
      .then(setSummary)
      .catch(e => setFailure(e.message));
  }, [session.token]);

  if (failure) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!summary) return <Screen><Loading /></Screen>;

  const { estimate, quota } = summary;
  const quotaRatio = Math.min(quota.hoursWithOperator / quota.quotaHours, 1);

  return (
    <Screen>
      <Title>Heures et gains</Title>
      <Small>30 derniers jours</Small>

      <View style={{ height: spacing.lg }} />

      <Card>
        <Row left="Heures prestées" right={`${estimate.hours.toFixed(2)} h`} />
        <Row left="Salaire" right={euros(estimate.wageCents)} />
        <Row left={`Primes de livraison (${estimate.deliveries})`}
             right={euros(estimate.deliveryBonusCents)} />
        <Row left="Primes d'étage" right={euros(estimate.floorBonusCents)} />
        <Row left="Pourboires" right={euros(estimate.tipsCents)} />
        <Divider />
        <Row left="Total estimé" right={euros(estimate.totalCents)} strong />
      </Card>

      <Card tone="notice">
        <Small muted={false}>Ce chiffre est une estimation</Small>
        <Small>{summary.disclaimer}</Small>
      </Card>

      <Card tone={quota.alerting ? 'notice' : 'default'}>
        <Small muted={false}>Quota étudiant {quota.year}</Small>
        <View style={{ height: spacing.sm }} />
        <Row left="Heures chez nous"
             right={`${quota.hoursWithOperator.toFixed(1)} / ${quota.quotaHours} h`} />

        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`Quota : ${quota.hoursWithOperator.toFixed(1)} heures sur ${quota.quotaHours}`}
          accessibilityValue={{ min: 0, max: quota.quotaHours, now: quota.hoursWithOperator }}
          style={{
            height: 10, borderRadius: 5, backgroundColor: palette.border,
            overflow: 'hidden', marginTop: spacing.sm,
          }}
        >
          <View style={{
            width: `${quotaRatio * 100}%`, height: '100%',
            backgroundColor: quota.alerting ? palette.warning : palette.primary,
          }} />
        </View>

        {quota.alerting ? (
          <>
            <View style={{ height: spacing.sm }} />
            <Small muted={false}>
              Tu approches du seuil de {quota.alertThresholdHours} h. Au-delà du
              quota, tes cotisations changent.
            </Small>
          </>
        ) : null}
      </Card>

      <Button label="Retour" variant="ghost" onPress={() => router.replace('/palettier')} />
    </Screen>
  );
}
