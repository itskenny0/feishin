import { PostProcessorModule } from 'i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Only English ships in the entry chunk. The other ~27 locales (~1.6 MB of
// JSON) are loaded on demand the first time a user selects them, which keeps
// them out of the initial-load bundle. English stays statically imported so
// `i18n.t()` is synchronous and correct on first paint (and as the fallback
// language). See loadLanguage() below.
import en from './locales/en.json';

const resources = {
    en: { translation: en },
};

// Lazily-importable bundles for every non-English locale. Vite turns each
// glob entry into its own dynamically-imported chunk, so none of these are
// pulled into the entry bundle — they are fetched only when requested.
const localeLoaders = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*.json');

const loadedLanguages = new Set<string>(['en']);

/**
 * Ensure the resource bundle for `language` is registered with i18next,
 * dynamically importing its JSON chunk on first use. Resolves immediately
 * for English / already-loaded languages. Safe to call repeatedly.
 */
export const loadLanguage = async (language: string): Promise<void> => {
    if (!language || loadedLanguages.has(language)) return;

    const loader = localeLoaders[`./locales/${language}.json`];
    if (!loader) return;

    try {
        const module = await loader();
        i18n.addResourceBundle(language, 'translation', module.default, true, true);
        loadedLanguages.add(language);
    } catch (error) {
        console.error(`[i18n] failed to load locale "${language}"`, error);
    }
};

export const languages = [
    {
        label: 'English',
        value: 'en',
    },
    {
        label: 'العربية',
        value: 'ar',
    },
    {
        label: 'Català',
        value: 'ca',
    },
    {
        label: 'Čeština',
        value: 'cs',
    },
    {
        label: 'Deutsch',
        value: 'de',
    },
    {
        label: 'Español',
        value: 'es',
    },
    {
        label: 'Basque',
        value: 'eu',
    },
    {
        label: 'Français',
        value: 'fr',
    },
    {
        label: 'Bahasa Indonesia',
        value: 'id',
    },
    {
        label: 'Suomeksi',
        value: 'fi',
    },
    {
        label: 'Magyar',
        value: 'hu',
    },
    {
        label: 'Italiano',
        value: 'it',
    },
    {
        label: '日本語',
        value: 'ja',
    },
    {
        label: '한국어',
        value: 'ko',
    },
    {
        label: 'Latviešu',
        value: 'lv',
    },
    {
        label: 'Nederlands',
        value: 'nl',
    },
    {
        label: 'Norsk (Bokmål)',
        value: 'nb-NO',
    },
    {
        label: 'فارسی',
        value: 'fa',
    },
    {
        label: 'Português',
        value: 'pt',
    },
    {
        label: 'Português (Brasil)',
        value: 'pt-BR',
    },
    {
        label: 'Polski',
        value: 'pl',
    },
    {
        label: 'Русский',
        value: 'ru',
    },
    {
        label: 'Slovenščina',
        value: 'sl',
    },
    {
        label: 'Srpski',
        value: 'sr',
    },
    {
        label: 'Svenska',
        value: 'sv',
    },
    {
        label: 'Tamil',
        value: 'ta',
    },
    {
        label: 'Türkçe',
        value: 'tr',
    },
    {
        label: '简体中文',
        value: 'zh-Hans',
    },
    {
        label: '繁體中文',
        value: 'zh-Hant',
    },
];

const lowerCasePostProcessor: PostProcessorModule = {
    name: 'lowerCase',
    process: (value: string) => {
        return value.toLocaleLowerCase();
    },
    type: 'postProcessor',
};

const upperCasePostProcessor: PostProcessorModule = {
    name: 'upperCase',
    process: (value: string) => {
        return value.toLocaleUpperCase();
    },
    type: 'postProcessor',
};

const titleCasePostProcessor: PostProcessorModule = {
    name: 'titleCase',
    process: (value: string) => {
        return value.replace(/\S\S*/g, (txt) => {
            return txt.charAt(0).toLocaleUpperCase() + txt.slice(1).toLowerCase();
        });
    },
    type: 'postProcessor',
};

// const ignoreSentenceCaseLanguages = ['de'];

const sentenceCasePostProcessor: PostProcessorModule = {
    name: 'sentenceCase',
    process: (value: string) => {
        const sentences = value.split('. ');

        return sentences
            .map((sentence) => {
                return (
                    sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1).toLocaleLowerCase()
                );
            })
            .join('. ');
    },
    type: 'postProcessor',
};
i18n.use(lowerCasePostProcessor)
    .use(upperCasePostProcessor)
    .use(titleCasePostProcessor)
    .use(sentenceCasePostProcessor)
    .use(initReactI18next) // passes i18n down to react-i18next
    .init({
        fallbackLng: 'en',
        // language to use, more information here: https://www.i18next.com/overview/configuration-options#languages-namespaces-resources
        // you can use the i18n.changeLanguage function to change the language manually: https://www.i18next.com/overview/api#changelanguage
        // if you're using a language detector, do not define the lng option
        interpolation: {
            escapeValue: false, // react already safes from xss
        },
        resources,
    });

export default i18n;
