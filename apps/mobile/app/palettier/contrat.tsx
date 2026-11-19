/**
 * The student employment contract (spec 7.3).
 *
 * Shown in full before signing, with the figures that come from parameters,
 * and openly marked as a template awaiting legal validation — because it is
 * one. The official model comes from the social secretariat.
 */

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner, Checkbox }
  from '../../src/components/ui';
import { courierApi, ApiError } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros } from '../../src/theme';

export default function Contrat() {
  const router = useRouter();
  const session = useSession();

  const [contract, setContract] = useState<any>(null);
  const [read, setRead] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);

  useEffect(() => {
    if (!session.token) return;
    courierApi.contract(session.token)
      .then(setContract)
      .catch(e => setFailure(e.message));
  }, [session.token]);

  async function sign() {
    if (!session.token) return;
    setBusy(true);
    setFailure(null);
    try {
      await courierApi.signContract(session.token);
      setSigned(true);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  if (failure) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!contract) return <Screen><Loading /></Screen>;

  if (signed) {
    return (
      <Screen>
        <Title>Contrat signé</Title>
        <Card tone="success">
          <Body>
            Ton contrat est signé. L'équipe doit encore confirmer ta déclaration
            Dimona auprès de l'ONSS : c'est une obligation légale, et aucune
            mission ne peut t'être attribuée avant.
          </Body>
        </Card>
        <Button label="Retour" onPress={() => router.replace('/palettier')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Ton contrat</Title>

      <Card tone="notice">
        <Small muted={false}>Gabarit en attente de validation juridique</Small>
        <Small>
          Ce document reprend les paramètres en vigueur. Le modèle officiel
          vient du secrétariat social et prévaut sur cet affichage.
        </Small>
      </Card>

      <Card>
        <Small muted={false}>Employeur</Small>
        <View style={{ height: spacing.sm }} />
        <Body>{contract.employer.legalName}</Body>
        <Small>{contract.employer.address}</Small>
        <Small>BCE {contract.employer.bceNumber} · TVA {contract.employer.vatNumber}</Small>
      </Card>

      <Card>
        <Small muted={false}>Rémunération</Small>
        <View style={{ height: spacing.sm }} />
        <Row left="Salaire horaire brut"
             right={contract.hourlyWageCents ? euros(contract.hourlyWageCents) : 'à fixer'} />
        <Row left="Prime par livraison" right={euros(contract.bonuses.perDeliveryCents)} />
        <Row left="Prime par étage sans ascenseur" right={euros(contract.bonuses.perFloorCents)} />
        <Row left="Pourboires" right={`${Math.round(contract.bonuses.tipsShare * 100)} % pour toi`} />
        <Divider />
        <Small>Commission paritaire : {contract.jointCommittee}</Small>
      </Card>

      <Card>
        <Small muted={false}>Temps de travail</Small>
        <View style={{ height: spacing.sm }} />
        <Row left="Fin de service" right={contract.workingTime.serviceEndTime} />
        <Row left="Au-delà de" right={`${contract.workingTime.nightThreshold} : dérogation`} />
        <Row left="Maximum par jour" right={`${contract.workingTime.maxHoursPerDay} h`} />
        <Row left="Maximum par semaine" right={`${contract.workingTime.maxHoursPerWeek} h`} />
        <Row left="Quota annuel étudiant" right={`${contract.workingTime.annualQuotaHours} h`} />
      </Card>

      <Card>
        <Small muted={false}>Obligations de l'employeur</Small>
        <View style={{ height: spacing.sm }} />
        <Small>Assurance accidents du travail : {contract.employerObligations.insurance}</Small>
        <Small>Service externe de prévention : {contract.employerObligations.prevention}</Small>
        <Small>Règlement de travail : {contract.employerObligations.workRules}</Small>
      </Card>

      <Card>
        <Small muted={false}>Systèmes automatisés</Small>
        <View style={{ height: spacing.sm }} />
        <Small>
          Tu as droit à une explication écrite du fonctionnement de
          l'attribution des missions, consultable à tout moment. Refuser une
          mission n'entraîne aucune sanction automatique, et aucune décision
          importante te concernant n'est prise par le système : une personne la
          prend, la motive, et tu peux la contester.
        </Small>
      </Card>

      <Checkbox
        required
        label="J'ai lu ce contrat"
        description="Tu recevras une copie signée et le règlement de travail."
        checked={read}
        onToggle={setRead}
      />

      <Button label="Signer électroniquement" onPress={sign} disabled={!read} loading={busy} />
    </Screen>
  );
}
