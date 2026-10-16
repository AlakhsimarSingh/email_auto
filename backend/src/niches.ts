// Business-type presets for targeting. Each maps to Overture Maps `basic_category` values (primary source)
// and one OpenStreetMap tag (fallback discovery). Chains, banks, government, worship, schools, hospitals and
// utilities are deliberately absent: they are not small businesses that hire freelancers.

export type NichePreset = {
  id: string;
  label: string;
  group: string;
  /** Singular noun used in drafts and activity when a business has no finer category. */
  noun: string;
  overture: string[];
  osm: string;
};

export const NICHE_PRESETS: NichePreset[] = [
  { id: 'home_services', label: 'Home services & trades', group: 'Trades', noun: 'home service business',
    overture: ['home_service', 'building_or_construction_service', 'technical_service', 'environmental_or_ecological_service', 'security_service'], osm: 'craft=plumber' },
  { id: 'automotive', label: 'Auto repair & parts', group: 'Trades', noun: 'auto service',
    overture: ['automotive_service', 'vehicle_service', 'vehicle_parts_store'], osm: 'shop=car_repair' },
  { id: 'beauty', label: 'Salons, barbers & beauty', group: 'Beauty & wellness', noun: 'salon',
    overture: ['personal_or_beauty_service', 'personal_care_and_beauty_store'], osm: 'shop=hairdresser' },
  { id: 'wellness', label: 'Wellness, physio & fitness', group: 'Beauty & wellness', noun: 'wellness studio',
    overture: ['wellness_service', 'complementary_and_alternative_medicine', 'physical_medicine_and_rehabilitation', 'fitness_studio', 'gym', 'sport_or_fitness_facility'], osm: 'leisure=fitness_centre' },
  { id: 'restaurants', label: 'Restaurants & eateries', group: 'Food & hospitality', noun: 'restaurant',
    overture: ['restaurant', 'casual_eatery', 'food_service', 'food_truck_stand'], osm: 'amenity=restaurant' },
  { id: 'cafes_bars', label: 'Cafes, bars & breweries', group: 'Food & hospitality', noun: 'cafe',
    overture: ['coffee_shop', 'cafe', 'bar', 'smoothie_juice_bar', 'non_alcoholic_beverage_venue', 'lounge', 'brewery', 'winery', 'distillery'], osm: 'amenity=cafe' },
  { id: 'lodging', label: 'Hotels, B&Bs & inns', group: 'Food & hospitality', noun: 'hotel',
    overture: ['hotel', 'bed_and_breakfast', 'inn', 'lodging'], osm: 'tourism=guest_house' },
  { id: 'dental', label: 'Dental clinics', group: 'Health & clinics', noun: 'dental clinic',
    overture: ['dental_clinic'], osm: 'amenity=dentist' },
  { id: 'clinics', label: 'Medical & specialist clinics', group: 'Health & clinics', noun: 'clinic',
    overture: ['medical_service', 'diagnostics_imaging_or_lab_service', 'behavioral_or_mental_health_clinic', 'outpatient_care_facility', 'vision_or_eye_care_clinic', 'specialized_health_care', 'primary_care_or_general_clinic', 'walk_in_clinic'], osm: 'amenity=clinic' },
  { id: 'pets', label: 'Vets, groomers & pet stores', group: 'Health & clinics', noun: 'pet business',
    overture: ['animal_or_pet_service', 'animal_and_pet_store'], osm: 'amenity=veterinary' },
  { id: 'professional', label: 'Legal, finance & real estate', group: 'Professional services', noun: 'firm',
    overture: ['attorney_or_law_firm', 'legal_service', 'financial_service', 'real_estate_service', 'professional_service'], osm: 'office=lawyer' },
  { id: 'creative', label: 'Design, media, printing & events', group: 'Professional services', noun: 'studio',
    overture: ['design_service', 'media_service', 'printing_service', 'event_or_party_service', 'travel_service', 'event_venue'], osm: 'shop=copyshop' },
  { id: 'retail', label: 'Independent shops', group: 'Retail', noun: 'shop',
    overture: ['fashion_and_apparel_store', 'hardware_home_and_garden_store', 'flowers_and_gifts_store', 'specialty_store', 'books_music_and_video_store', 'arts_crafts_and_hobby_store', 'sporting_goods_store', 'electronics_store', 'second_hand_store', 'toys_and_games_store', 'food_and_beverage_store', 'musical_instrument_and_pro_audio_store'], osm: 'shop=florist' },
  { id: 'education', label: 'Tutoring, classes & clubs', group: 'Education & activities', noun: 'school',
    overture: ['tutoring_service', 'specialty_school', 'educational_service', 'sport_or_recreation_club'], osm: 'amenity=language_school' },
];

const BY_ID = new Map(NICHE_PRESETS.map((preset) => [preset.id, preset]));
const BY_CATEGORY = new Map(NICHE_PRESETS.flatMap((preset) => preset.overture.map((category) => [category, preset] as const)));

export function nichePreset(id: string | null | undefined) {
  return id ? BY_ID.get(id) ?? null : null;
}

export function presetForCategory(category: string | null | undefined) {
  return category ? BY_CATEGORY.get(category) ?? null : null;
}

/** Noun for a campaign's niche: a preset's noun, or the legacy free-text niche (e.g. "dentist"). */
export function nicheNoun(niche: string | null | undefined) {
  return nichePreset(niche)?.noun ?? niche ?? 'business';
}

/** "plumbing_service" -> "plumbing service". Falls back to the preset noun for generic categories. */
export function humanizeCategory(taxonomyPrimary: string | null | undefined, basicCategory: string | null | undefined) {
  const raw = (taxonomyPrimary || basicCategory || '').trim();
  if (!raw) return presetForCategory(basicCategory)?.noun ?? 'business';
  return raw.replaceAll('_', ' ').replace(/\s+/g, ' ').slice(0, 60);
}
