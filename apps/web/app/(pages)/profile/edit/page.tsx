import { ProfileScreen } from '@/features/profile/index.client'

/** §1.1: composes only. BS-148: the profile with its card turned into the edit form. */
export default function ProfileEditPage() {
  return <ProfileScreen mode="edit" />
}
