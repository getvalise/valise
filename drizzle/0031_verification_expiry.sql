-- Existing unverified tokens have no expiry and deliberately cannot activate an account.
ALTER TABLE `users` ADD `verification_expires_at` integer;
