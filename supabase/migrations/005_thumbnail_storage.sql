-- Thumbnails of cached messages are kept in a public Storage bucket, not in the message rows.
-- The worker writes them with the service role key, which bypasses storage policies, so no policy is needed.
-- A public bucket can be read by URL, which is how the Mini App shows the images and how the bot's cards get them.
-- The limits match thumbs.py: at most 150 KB per image, and only JPEG or PNG.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbs', 'thumbs', true, 1000000, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
