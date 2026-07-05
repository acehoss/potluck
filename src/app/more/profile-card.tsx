'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { downscaleToJpeg, uploadImage } from '@/lib/downscale';
import { useTRPC } from '@/lib/trpc';

/**
 * My profile card (REWORK P5, Round C). Every member owns their own card —
 * photo, name, phone, bio — edited through a sheet (profile.update). The avatar
 * is an "avatars"-kind upload (downscale → uploadImage), circle-cropped on
 * display. What a connected household actually SEES of this card is governed
 * elsewhere by Membership.visibility + circles (the member-visibility control).
 */

const inputClass =
  'min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/25';
const primaryBtn =
  'min-h-11 flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-contrast transition-colors hover:bg-accent-strong disabled:bg-accent/50 disabled:text-accent-contrast/70';
const secondaryBtn =
  'min-h-11 flex-1 rounded-lg border border-border-strong px-4 py-2.5 font-medium text-text transition-colors hover:bg-surface-sunken disabled:opacity-50';

/** A round avatar, or a monogram fallback when there's no photo. */
export function Avatar({
  photoPath,
  name,
  className = 'size-16',
}: {
  photoPath: string | null;
  name: string;
  className?: string;
}) {
  if (photoPath) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/images/${photoPath}`}
        alt=""
        className={`${className} shrink-0 rounded-full border border-border object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-surface-sunken font-semibold text-text-muted`}
    >
      {name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

export function ProfileCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const profile = useQuery(trpc.profile.get.queryOptions());
  const [editing, setEditing] = useState(false);

  if (!profile.data) return null;
  const p = profile.data;

  return (
    <section
      data-testid="profile-card"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4 shadow-sm"
    >
      <div className="flex items-center gap-4">
        <Avatar photoPath={p.photoPath} name={p.name} className="size-16" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-text">{p.name}</h2>
          <p className="truncate text-xs text-text-muted">@{p.username}</p>
          {p.phone && <p className="truncate text-sm text-text">{p.phone}</p>}
        </div>
        <button
          type="button"
          data-testid="profile-edit"
          onClick={() => setEditing(true)}
          className="min-h-11 shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-surface-sunken"
        >
          Edit
        </button>
      </div>
      {p.bio && <p className="text-sm text-text-muted">{p.bio}</p>}

      {editing && (
        <ProfileSheet
          initial={p}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            void queryClient.invalidateQueries(trpc.profile.get.pathFilter());
          }}
        />
      )}
    </section>
  );
}

type ProfileData = {
  name: string;
  username: string;
  email: string;
  phone: string | null;
  bio: string | null;
  photoPath: string | null;
};

/** Edit sheet: photo + name/phone/bio. Email is identity, shown but not editable. */
function ProfileSheet({
  initial,
  onClose,
  onDone,
}: {
  initial: ProfileData;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [bio, setBio] = useState(initial.bio ?? '');
  const [newPhoto, setNewPhoto] = useState<{ path: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useMutation(
    trpc.profile.update.mutationOptions({
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    }),
  );

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const jpeg = await downscaleToJpeg(file);
      const { path } = await uploadImage('avatars', jpeg);
      if (newPhoto) URL.revokeObjectURL(newPhoto.preview);
      setNewPhoto({ path, preview: URL.createObjectURL(jpeg) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const previewSrc = newPhoto
    ? newPhoto.preview
    : initial.photoPath
      ? `/api/images/${initial.photoPath}`
      : null;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-scrim sm:items-center">
      <form
        data-testid="profile-sheet"
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl border border-border bg-surface-raised p-4 shadow-sm sm:rounded-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) {
            setError('Give yourself a name.');
            return;
          }
          update.mutate({
            name: trimmed,
            phone: phone.trim() || null,
            bio: bio.trim() || null,
            photoPath: newPhoto?.path, // undefined = keep the current photo
          });
        }}
      >
        <h2 className="text-lg font-semibold">Edit profile</h2>

        <div className="flex items-center gap-4">
          {previewSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewSrc}
              alt=""
              className="size-20 shrink-0 rounded-full border border-border object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-20 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xl font-semibold text-text-muted"
            >
              {name.trim().charAt(0).toUpperCase() || '·'}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            data-testid="profile-photo-input"
            onChange={(e) => handleFile(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : previewSrc ? 'Replace photo' : 'Add photo'}
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Name
          <input
            type="text"
            required
            data-testid="profile-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Phone (optional)
          <input
            type="tel"
            data-testid="profile-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="555-0142"
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-text">
          Bio (optional)
          <textarea
            data-testid="profile-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            placeholder="A little about you"
            className={`${inputClass} resize-none`}
          />
        </label>

        <p className="text-xs text-text-muted">
          Signed in as <span className="font-medium text-text">{initial.email}</span> — your email
          stays your recovery address, not shown on your card.
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="profile-save"
            disabled={update.isPending || uploading}
            className={primaryBtn}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
