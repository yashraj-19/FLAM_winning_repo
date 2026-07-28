import { redirect } from 'next/navigation';

/** The dashboard is the whole product; the root just forwards to it. */
export default function Home() {
  redirect('/dashboard');
}
