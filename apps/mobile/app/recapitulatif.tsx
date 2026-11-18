/**
 * Pre-payment summary (spec 6.7 and 4.6).
 *
 * This screen is where several blocking requirements land at once: the full
 * price including every fee before any commitment, the gap rule against the
 * till receipt, the cancellation conditions, the operator's identity, and a
 * button whose wording leaves no doubt that pressing it means paying.
 *
 * Note that the figures are NOT computed here. The order is created on the
 * server, which prices it; this screen displays what came back. That is what
 * makes "the displayed total equals the debited amount" true rather than
 * hopeful.
 */

import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Card, Row, Divider, ErrorBanner, Loading }
  from '../src/components/ui';
import { api, ApiError, type PlacedOrder } from '../src/api';
import { useSession, usePublicSettings } from '../src/session';
import { spacing, euros } from '../src/theme';

export default function Recapitulatif() {
  const router = useRouter();
  const session = useSession();
  const settings = usePublicSettings();

  const [quote, setQuote] = useState<PlacedOrder | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasAlcohol = session.basket.some(l => l.product.contains_alcohol);

  async function placeOrder() {
    if (!session.token || !session.addressId || !session.storeId) {
      setFailure('Choisissez une adresse avant de commander.');
      return;
    }

    setBusy(true);
    setFailure(null);

    try {
      const placed = await api.placeOrder(session.token, {
        addressId: session.addressId,
        storeId: session.storeId,
        mode: 'express',
        method: 'bancontact',
        lines: session.basket.map(l => ({
          productId: l.product.product_id,
          quantity: l.quantity,
        })),
      });

      setQuote(placed);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  function goToTracking() {
    if (!quote) return;
    session.clearBasket();
    router.replace(`/commande/${quote.orderId}`);
  }

  if (busy) return <Screen><Loading label="Calcul du total…" /></Screen>;

  return (
    <Screen>
      <Title>Récapitulatif</Title>

      {failure ? <ErrorBanner message={failure} /> : null}

      <Card>
        {session.basket.map(line => (
          <Row
            key={line.product.product_id}
            left={`${line.quantity} × ${line.product.name}`}
            right={euros(line.product.indicative_price_cents * line.quantity)}
          />
        ))}
      </Card>

      {quote ? (
        <>
          <Card>
            <Row left="Articles (prix indicatif)" right={euros(quote.amounts.itemsCents)} />
            <Row left="Frais de livraison" right={euros(quote.amounts.deliveryCents)} />
            <Row left="Frais de service" right={euros(quote.amounts.serviceCents)} />
            {quote.amounts.tipCents > 0
              ? <Row left="Pourboire" right={euros(quote.amounts.tipCents)} /> : null}
            <Divider />
            <Row left="Total TTC" right={euros(quote.amounts.totalCents)} strong />
          </Card>

          <Card tone="notice">
            <Small muted={false}>Prix des articles</Small>
            <Small>
              Le prix affiché par article est indicatif. Vous payez le prix exact
              du ticket de caisse : si le ticket est inférieur, la différence
              vous est remboursée automatiquement. S'il est supérieur, nous
              absorbons l'écart, et au-delà nous vous demandons votre accord
              avant tout débit complémentaire.
            </Small>
          </Card>

          <Card>
            <Small muted={false}>Annulation</Small>
            <Small>{quote.cancellationTerms.explanation}</Small>
          </Card>

          {hasAlcohol ? (
            <Card tone="notice">
              <Small muted={false}>Remise d'alcool</Small>
              <Small>
                Le palettier contrôlera la pièce d'identité de la personne qui
                réceptionne, et refusera la remise si l'âge n'est pas prouvé ou
                si la personne est manifestement ivre.
              </Small>
              {settings ? <Small>{settings.healthWarning}</Small> : null}
            </Card>
          ) : null}

          {settings ? (
            <Card>
              <Small muted={false}>Vendeur</Small>
              <Small>{settings.operator.legalName}</Small>
              <Small>{settings.operator.address}</Small>
              <Small>TVA {settings.operator.vatNumber} · BCE {settings.operator.bceNumber}</Small>
            </Card>
          ) : null}

          <Button
            label={settings?.payButtonLabel ?? 'Commander et payer'}
            onPress={goToTracking}
            accessibilityHint={`Montant à payer : ${euros(quote.amounts.totalCents)}`}
          />

          <Small>
            En validant, vous vous engagez à payer {euros(quote.amounts.totalCents)}.
          </Small>
        </>
      ) : (
        <>
          <Card>
            <Body muted>
              Le total exact, frais compris, s'affiche avant toute validation.
            </Body>
          </Card>
          <Button label="Calculer le total" onPress={placeOrder} />
        </>
      )}
    </Screen>
  );
}
