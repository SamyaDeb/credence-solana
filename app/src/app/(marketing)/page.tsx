import { AppleWatch } from '@/components/landing/AppleWatch';
import { CallToAction } from '@/components/landing/CallToAction';
import { Explore } from '@/components/landing/Explore';
import { Features } from '@/components/landing/Features';
import { Footer } from '@/components/landing/Footer';
import { Hero } from '@/components/landing/Hero';
import { Motion } from '@/components/landing/Motion';
import { Navbar } from '@/components/landing/Navbar';
import { ProductTabs } from '@/components/landing/ProductTabs';
import { WhyUs } from '@/components/landing/WhyUs';

export default function LandingPage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <WhyUs />
        <Explore />
        <AppleWatch />
        <ProductTabs />
        <CallToAction />
      </main>
      <Footer />
      <Motion />
    </>
  );
}
