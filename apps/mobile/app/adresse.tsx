/**
 * Delivery address (spec 6.3).
 *
 * The map pin is mandatory because GPS is unreliable on the Louvain-la-Neuve
 * slab. An address outside every zone is refused by the server; one inside a
 * zone that is not open yet leads to the waiting list rather than a dead end.
 */

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Title, Body, Small, Button, Field, Checkbox, Card, ErrorBanner, Divider }
  from '../src/components/ui';
import { api, ApiError, type Address } from '../src/api';
import { useSession } from '../src/session';
import { spacing } from '../src/theme';

/** Centre of the demo zone, used as the starting point for the pin. */
const DEFAULT_PIN = { lat: '50.6680', lon: '4.6150' };

export default function Adresse() {
  const router = useRouter();
  const session = useSession();

  const [existing, setExisting] = useState<Address[] | null>(null);
  const [street, setStreet] = useState('');
  const [number, setNumber] = useState('');
  const [building, setBuilding] = useState('');
  const [floor, setFloor] = useState('0');
  const [room, setRoom] = useState('');
  const [hasLift, setHasLift] = useState(false);
  const [lat, setLat] = useState(DEFAULT_PIN.lat);
  const [lon, setLon] = useState(DEFAULT_PIN.lon);
  const [instructions, setInstructions] = useState('');

  const [failure, setFailure] = useState<string | null>(null);
  const [waitlisted, setWaitlisted] = useState<{ slug: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session.token) return;
    api.addresses(session.token)
      .then(result => setExisting(result.addresses))
      .catch(() => setExisting([]));
  }, [session.token]);

  async function submit() {
    if (!session.token) return;
    setBusy(true);
    setFailure(null);
    setWaitlisted(null);

    try {
      const result = await api.createAddress(session.token, {
        label: building || 'Kot',
        street, number, building, room,
        floor: Number(floor) || 0,
        hasLift,
        lat: Number(lat), lon: Number(lon),
        instructions,
        isDefault: true,
      });

      if (!result.serviceAvailable) {
        setWaitlisted(result.zone);
        return;
      }

      session.setAddressId(result.addressId);
      router.push('/catalogue');
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  async function joinWaitlist() {
    if (!session.token || !waitlisted) return;
    await api.joinWaitlist(session.token, waitlisted.slug);
    router.replace('/');
  }

  function useExisting(address: Address) {
    session.setAddressId(address.id);
    router.push('/catalogue');
  }

  return (
    <Screen>
      <Title>Votre kot</Title>

      {existing && existing.length > 0 ? (
        <>
          <Body muted>Adresses enregistrées</Body>
          <View style={{ height: spacing.sm }} />
          {existing.map(address => (
            <Card key={address.id}>
              <Body>{address.street} {address.number}</Body>
              <Small>
                {address.zone_name} · étage {address.floor}
                {address.has_lift ? ' · avec ascenseur' : ' · sans ascenseur'}
              </Small>
              <Button label="Livrer ici" variant="secondary" onPress={() => useExisting(address)} />
            </Card>
          ))}
          <Divider style={{ marginVertical: spacing.lg }} />
          <Body muted>Ou ajoutez une nouvelle adresse</Body>
          <View style={{ height: spacing.md }} />
        </>
      ) : null}

      {failure ? <ErrorBanner message={failure} /> : null}

      {waitlisted ? (
        <Card tone="notice">
          <Body>
            Nous ne livrons pas encore à {waitlisted.name}. Rejoignez la liste
            d'attente : le quartier ouvre dès que le seuil de voisins et de
            palettiers est atteint.
          </Body>
          <Button label="Rejoindre la liste d'attente" onPress={joinWaitlist} />
        </Card>
      ) : null}

      <Field label="Rue" value={street} onChangeText={setStreet} />
      <Field label="Numéro" value={number} onChangeText={setNumber} />
      <Field label="Bâtiment ou kot-à-projet" value={building} onChangeText={setBuilding}
             hint="Facultatif" />
      <Field label="Étage" value={floor} onChangeText={setFloor} keyboardType="numeric"
             hint="0 pour le rez-de-chaussée. L'étage influence les frais de livraison." />
      <Field label="Chambre" value={room} onChangeText={setRoom} hint="Facultatif" />

      <Checkbox
        label="Il y a un ascenseur"
        description="Avec ascenseur, les frais d'étage sont un forfait au lieu d'être comptés par étage."
        checked={hasLift}
        onToggle={setHasLift}
      />

      <Divider />

      <Small muted={false}>Épingle sur la carte</Small>
      <Small>
        Obligatoire : le GPS est imprécis sur la dalle, et le palettier doit
        pouvoir trouver l'entrée du premier coup.
      </Small>
      <View style={{ height: spacing.sm }} />

      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Field label="Latitude" value={lat} onChangeText={setLat} keyboardType="numeric" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Longitude" value={lon} onChangeText={setLon} keyboardType="numeric" />
        </View>
      </View>

      <Field label="Instructions pour le palettier" value={instructions}
             onChangeText={setInstructions}
             hint="Par exemple : « sonner au nom du kot, la porte du bas coince »." />

      <Button label="Enregistrer cette adresse" onPress={submit} loading={busy} />
    </Screen>
  );
}
