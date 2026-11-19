/**
 * The guided mission (spec 7.6).
 *
 * The step comes from the server, derived from the order's state — not held
 * in this screen. A courier whose phone dies mid-mission, or who reinstalls
 * the app, reopens it exactly where they were (spec 18: "reprise après
 * crash").
 *
 * The handover is deliberately the strictest part: the age check and the PIN
 * are two separate steps, in that order, and neither can be queued offline.
 * Telling someone a delivery succeeded before the server has checked the age
 * gate would defeat the one rule that carries criminal liability.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  Screen, Title, Body, Small, Button, Card, Row, Divider, Loading, ErrorBanner,
  Field, Checkbox,
} from '../../src/components/ui';
import { courierApi, ApiError, type GuidedMission } from '../../src/api';
import { useSession } from '../../src/session';
import { spacing, euros, palette } from '../../src/theme';

export default function Mission() {
  const router = useRouter();
  const session = useSession();

  const [state, setState] = useState<GuidedMission | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [documentChecked, setDocumentChecked] = useState(false);
  const [sober, setSober] = useState(false);
  const [pin, setPin] = useState('');
  const [handoverNote, setHandoverNote] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Ticks once a second so the substitution countdown is live. Stopped when
  // nothing is pending, so the screen is not repainting for no reason.
  useEffect(() => {
    if (!state?.pendingSubstitutions?.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state?.pendingSubstitutions?.length]);

  const load = useCallback(async () => {
    if (!session.token) return;
    try {
      setState(await courierApi.mission(session.token));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    }
  }, [session.token]);

  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await fn();
      await load();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  if (failure && !state) return <Screen><ErrorBanner message={failure} /></Screen>;
  if (!state) return <Screen><Loading /></Screen>;

  if (!state.mission) {
    return (
      <Screen>
        <Title>Aucune mission</Title>
        <Body muted>Tu n'as pas de mission en cours.</Body>
        <Button label="Voir les offres" onPress={() => router.replace('/palettier/offres')} />
        <Button label="Retour" variant="ghost" onPress={() => router.replace('/palettier')} />
      </Screen>
    );
  }

  const { mission, step, instruction } = state;
  const order = mission.orders[0]!;
  const token = session.token!;

  return (
    <Screen>
      <Title>Mission en cours</Title>

      <Card tone="notice">
        <Small muted={false}>Étape</Small>
        <Body>{instruction}</Body>
      </Card>

      {failure ? <ErrorBanner message={failure} /> : null}

      {/* ---------------------------------------------------------- magasin */}
      {step === 'go_to_store' ? (
        <>
          <Card>
            <Small muted={false}>Magasin</Small>
            <Body>{mission.storeName}</Body>
            <Small>{mission.storeStreet} {mission.storeNumber}</Small>
          </Card>
          <Button label="Je suis au magasin" loading={busy}
                  onPress={() => act(() => courierApi.atStore(token, mission.missionId))} />
        </>
      ) : null}

      {/* ---------------------------------------------------------- courses */}
      {step === 'shop' ? (
        <>
          <Card>
            <Small muted={false}>À acheter</Small>
            <View style={{ height: spacing.sm }} />
            {order.items.map(item => {
              const pending = state.pendingSubstitutions?.find(
                s => s.orderItemId === item.orderItemId);
              const secondsLeft = pending
                ? Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - now) / 1000))
                : 0;

              return (
                <View key={item.orderItemId} style={{ marginBottom: spacing.md }}>
                  <Row left={`${item.quantity} × ${item.productName}`}
                       right={euros(item.indicativePriceCents * item.quantity)} />
                  <Small>{item.format}</Small>

                  {item.refunded ? (
                    <Small muted={false}>Retiré de la commande et remboursé.</Small>
                  ) : null}

                  {item.containsAlcohol ? (
                    <Small muted={false}>Produit alcoolisé — contrôle d'âge à la remise</Small>
                  ) : null}

                  {pending ? (
                    <View style={{ marginTop: spacing.xs }}>
                      <Small muted={false}>
                        {secondsLeft > 0
                          ? `En attente de la réponse du client — ${secondsLeft} s`
                          : 'Délai écoulé'}
                      </Small>
                      {secondsLeft === 0 ? (
                        <Button
                          label="Appliquer son choix par défaut"
                          variant="secondary"
                          loading={busy}
                          onPress={() => act(() =>
                            courierApi.applyDefaultSubstitution(token, pending.id))}
                        />
                      ) : null}
                    </View>
                  ) : reporting === item.orderItemId ? (
                    <View style={{ marginTop: spacing.xs }}>
                      <Button label="Rupture de stock" variant="secondary" loading={busy}
                              onPress={() => act(async () => {
                                await courierApi.requestSubstitution(token, {
                                  orderItemId: item.orderItemId, reason: 'out_of_stock',
                                });
                                setReporting(null);
                              })} />
                      <Button label="Prix très différent" variant="secondary" loading={busy}
                              onPress={() => act(async () => {
                                await courierApi.requestSubstitution(token, {
                                  orderItemId: item.orderItemId, reason: 'price_gap',
                                });
                                setReporting(null);
                              })} />
                      <Button label="Annuler" variant="ghost"
                              onPress={() => setReporting(null)} />
                    </View>
                  ) : (
                    <Button
                      label="Signaler un problème sur cet article"
                      variant="ghost"
                      onPress={() => setReporting(item.orderItemId)}
                      accessibilityHint={`Signaler un problème sur ${item.productName}`}
                    />
                  )}
                </View>
              );
            })}
            <Divider />
            <Small>
              Si un article manque, signale-le : le client a quelques minutes
              pour répondre. Passé ce délai, c'est la règle qu'il a choisie en
              commandant qui s'applique — tu ne décides pas à sa place.
            </Small>
            <View style={{ height: spacing.sm }} />
            <Small>
              Paie avec la carte de dépense. Plafond pour cette mission :{' '}
              {euros(mission.spendCardCeilingCents)}. Tu n'avances jamais ton
              propre argent.
            </Small>
          </Card>

          <Card>
            <Small muted={false}>Ticket de caisse</Small>
            <Small>
              Photographie le ticket. Si le montant lu est faux, corrige-le :
              c'est ta saisie qui fait foi, pas la lecture automatique.
            </Small>
            <View style={{ height: spacing.sm }} />
            <Field
              label="Montant du ticket, en euros"
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
              hint="Par exemple 14,99"
            />
            <Button
              label="Valider le ticket"
              loading={busy}
              disabled={!amount.trim()}
              onPress={() => act(() => courierApi.receipt(token, {
                missionId: mission.missionId,
                orderId: order.orderId,
                photoPath: `receipt-${order.reference}.jpg`,
                amountOverrideCents: Math.round(
                  Number.parseFloat(amount.replace(',', '.')) * 100),
              }))}
            />
          </Card>
        </>
      ) : null}

      {/* ---------------------------------------------------------- trajet */}
      {step === 'travel' ? (
        <>
          <Card>
            <Small muted={false}>Livrer à</Small>
            <Body>{order.street} {order.number}</Body>
            {order.building ? <Small>{order.building}</Small> : null}
            <Small>
              Étage {order.floor}{order.hasLift ? ', avec ascenseur' : ', sans ascenseur'}
              {order.room ? ` · ${order.room}` : ''}
            </Small>
            {order.instructions ? (
              <>
                <View style={{ height: spacing.sm }} />
                <Small muted={false}>{order.instructions}</Small>
              </>
            ) : null}
            {order.noteForCourier ? (
              <Small muted={false}>Note du client : {order.noteForCourier}</Small>
            ) : null}
          </Card>

          <Button label="Je pars livrer" loading={busy}
                  onPress={() => act(() => courierApi.depart(
                    token, mission.missionId, order.orderId))} />
        </>
      ) : null}

      {/* ---------------------------------------------------------- remise */}
      {step === 'handover' ? (
        <>
          {order.status !== 'ARRIVED' ? (
            <Button label="Je suis arrivé" loading={busy}
                    onPress={() => act(() => courierApi.arrive(token, order.orderId))} />
          ) : (
            <>
              {order.containsAlcohol ? (
                <Card tone="notice">
                  <Small muted={false}>Contrôle d'âge obligatoire</Small>
                  <Small>
                    Regarde la pièce d'identité de la personne qui réceptionne.
                    L'année que tu lis n'est jamais enregistrée : l'app calcule
                    seulement si l'âge suffit. Ne photographie jamais une pièce
                    d'identité.
                  </Small>

                  <View style={{ height: spacing.sm }} />

                  <Checkbox
                    label="Pièce d'identité vérifiée"
                    checked={documentChecked}
                    onToggle={setDocumentChecked}
                  />
                  <Checkbox
                    label="Personne en état normal"
                    description="Décoche si la personne est manifestement ivre : tu dois alors refuser."
                    checked={sober}
                    onToggle={setSober}
                  />

                  <Button
                    label="Valider le contrôle"
                    loading={busy}
                    disabled={!documentChecked || !sober}
                    onPress={() => act(async () => {
                      const result = await courierApi.ageCheck(token, order.orderId, {
                        documentChecked, personAppearsSober: sober,
                      });
                      setHandoverNote(result.message);
                    })}
                  />

                  <Button
                    label="Refuser la remise"
                    variant="danger"
                    loading={busy}
                    onPress={() => act(async () => {
                      const result = await courierApi.ageCheck(token, order.orderId, {
                        documentChecked, personAppearsSober: false,
                        refusalReason: documentChecked ? 'visibly_intoxicated' : 'age_not_proven',
                      });
                      setHandoverNote(result.message);
                    })}
                  />
                </Card>
              ) : null}

              {handoverNote ? (
                <Card tone="success"><Body>{handoverNote}</Body></Card>
              ) : null}

              <Card>
                <Small muted={false}>Code PIN</Small>
                <Small>
                  Demande le code au client{order.containsAlcohol
                    ? ', après le contrôle d\'âge' : ''}.
                </Small>
                <View style={{ height: spacing.sm }} />
                <Field
                  label="Code à 4 chiffres"
                  value={pin}
                  onChangeText={setPin}
                  keyboardType="numeric"
                />
                <Button
                  label="Valider la remise"
                  loading={busy}
                  disabled={pin.length !== 4}
                  onPress={() => act(async () => {
                    const result = await courierApi.deliver(token, order.orderId, pin);
                    setHandoverNote(result.message);
                    if (result.delivered) router.replace('/palettier');
                  })}
                />
              </Card>
            </>
          )}
        </>
      ) : null}

      <Divider />

      <Card>
        <Small muted={false}>Besoin d'aide ?</Small>
        <Small>
          Un bouton, une personne au bout. Tu peux aussi mettre ta mission en
          pause.
        </Small>
        <Button
          label="Contacter l'équipe"
          variant="secondary"
          onPress={() => act(async () => {
            const result = await courierApi.help(token, `Mission ${mission.missionId}`);
            setHandoverNote(`${result.message} ${result.contact}`);
          })}
        />
      </Card>

      <Small>
        Ta position n'est partagée que pendant ton créneau réservé, et
        uniquement pendant la mission.
      </Small>
    </Screen>
  );
}
