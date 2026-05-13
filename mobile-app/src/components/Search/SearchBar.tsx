import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { apiService } from '../../services/api';

export interface SearchResult {
  name: string;
  address: string;
  location: string;
}

type SearchMode = 'place' | 'parameter' | 'coordinate';

interface SearchBarProps {
  onSearch: (keyword: string) => void;
  onResultSelect: (result: SearchResult) => void;
  placeholder?: string;
  onModeChange?: (mode: SearchMode) => void;
  onClear?: () => void;
}

export default function SearchBar({
  onSearch,
  onResultSelect,
  placeholder = '搜索地点...',
  onModeChange,
  onClear,
}: SearchBarProps) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>('place');
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  const searchPlace = useCallback(async (kw: string): Promise<SearchResult[]> => {
    const apiKey = '5299af602f4ee3cd7351c1bc7f32b1cb';
    const url = `https://restapi.amap.com/v3/place/text?key=${apiKey}&keywords=${encodeURIComponent(kw)}&output=json`;
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data.status === '1' && data.pois) {
        return data.pois.map((poi: any) => ({
          name: poi.name,
          address: poi.address || '',
          location: poi.location,
        }));
      }
    } catch (error) {
      console.error('Search failed:', error);
    }
    return [];
  }, []);

  const performSearch = useCallback(async (kw: string, mode: SearchMode): Promise<SearchResult[]> => {
    if (!kw.trim()) {
      setResults([]);
      setShowResults(false);
      return [];
    }

    let searchResults: SearchResult[] = [];

    if (mode === 'place') {
      searchResults = await searchPlace(kw);
    } else if (mode === 'parameter') {
      const paramResults = await apiService.searchParameter(kw);
      searchResults = paramResults.map((s: any) => ({
        name: s.name || '未命名小区',
        address: `${s.networkType || ''} | 基站: ${s.siteId || 'N/A'} | PCI: ${s.pci || 'N/A'}`,
        location: `${s.longitude},${s.latitude}`,
      }));
    } else if (mode === 'coordinate') {
      const coordMatch = kw.match(/^\s*(-?\d+\.?\d*)\s*[,，\s]\s*(-?\d+\.?\d*)\s*$/);
      if (coordMatch) {
        searchResults = [{
          name: `坐标定位 (${coordMatch[1].trim()}, ${coordMatch[2].trim()})`,
          address: '点击定位到该坐标',
          location: `${coordMatch[1].trim()},${coordMatch[2].trim()}`,
        }];
      }
    }

    setResults(searchResults);
    setShowResults(searchResults.length > 0);
    return searchResults;
  }, [searchPlace]);

  // 点击放大镜按钮：有结果时默认选中第一个跳转，无结果则触发搜索后选第一个
  const handleSearchButtonPress = useCallback(async () => {
    if (!keyword.trim()) return;

    // 如果已有搜索结果，直接选第一个跳转
    if (results.length > 0) {
      onResultSelect(results[0]);
      setShowResults(false);
      setKeyword('');
      return;
    }

    // 否则触发搜索并选第一个
    setIsSearching(true);
    const searchResults = await performSearch(keyword, searchMode);
    setIsSearching(false);

    if (searchResults.length > 0) {
      onResultSelect(searchResults[0]);
      setShowResults(false);
      setKeyword('');
    }
  }, [keyword, searchMode, results, performSearch, onResultSelect]);

  // 实时搜索：输入变化时触发（debounce 300ms）
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      performSearch(keyword, searchMode);
      onSearch(keyword);
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [keyword, searchMode, performSearch, onSearch]);

  const handleClear = () => {
    setKeyword('');
    setResults([]);
    setShowResults(false);
    onClear?.();
  };

  const handleModeChange = (mode: SearchMode) => {
    setSearchMode(mode);
    onModeChange?.(mode);
    setKeyword('');
    setResults([]);
    setShowResults(false);
  };

  const getPlaceholder = () => {
    switch (searchMode) {
      case 'place': return '搜索地点...';
      case 'parameter': return '搜索小区名/基站ID...';
      case 'coordinate': return '输入经纬度，如: 113.123,23.456';
      default: return placeholder;
    }
  };

  // SVG 放大镜图标（完整、无残缺）
  const SearchIconSVG = () => (
    <View style={styles.searchIconContainer}>
      <View style={styles.searchIconCircle} />
      <View style={styles.searchIconHandle} />
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.modeToggle}>
        <TouchableOpacity
          style={[styles.modeBtn, searchMode === 'place' && styles.modeBtnActive]}
          onPress={() => handleModeChange('place')}
        >
          <Text style={[styles.modeBtnText, searchMode === 'place' && styles.modeBtnTextActive]}>地点</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, searchMode === 'parameter' && styles.modeBtnActive]}
          onPress={() => handleModeChange('parameter')}
        >
          <Text style={[styles.modeBtnText, searchMode === 'parameter' && styles.modeBtnTextActive]}>小区</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, searchMode === 'coordinate' && styles.modeBtnActive]}
          onPress={() => handleModeChange('coordinate')}
        >
          <Text style={[styles.modeBtnText, searchMode === 'coordinate' && styles.modeBtnTextActive]}>坐标</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={keyword}
          onChangeText={setKeyword}
          placeholder={getPlaceholder()}
          onSubmitEditing={() => handleSearchButtonPress()}
          returnKeyType="search"
        />
        {keyword.length > 0 && (
          <TouchableOpacity style={styles.clearButton} onPress={handleClear}>
            <Text style={styles.clearButtonText}>×</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.searchButton}
          onPress={handleSearchButtonPress}
          disabled={isSearching}
        >
          {isSearching ? (
            <ActivityIndicator size="small" color="#555" />
          ) : (
            <SearchIconSVG />
          )}
        </TouchableOpacity>
      </View>
      {showResults && results.length > 0 && (
        <View style={styles.resultsContainer}>
          <FlatList
            data={results}
            keyExtractor={(item, index) => `${item.name}-${index}`}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.resultItem}
                onPress={() => {
                  onResultSelect(item);
                  setShowResults(false);
                  setKeyword('');
                  setResults([]);
                }}
              >
                <Text style={styles.resultName}>{item.name}</Text>
                {item.address ? (
                  <Text style={styles.resultAddress}>{item.address}</Text>
                ) : null}
              </TouchableOpacity>
            )}
            style={styles.resultsList}
            keyboardShouldPersistTaps="always"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 10,
    zIndex: 100,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
  },
  modeToggle: {
    flexDirection: 'row',
    marginBottom: 3,
    gap: 3,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 4,
    borderRadius: 5,
    backgroundColor: 'rgba(0,0,0,0.06)',
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: '#007AFF' },
  modeBtnText: { fontSize: 12, color: '#555', fontWeight: '500' },
  modeBtnTextActive: { color: '#fff' },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: 34,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingRight: 36,
    paddingVertical: 0,
    fontSize: 12,
    backgroundColor: 'rgba(255,255,255,0.7)',
    textAlignVertical: 'center',
  },
  searchButton: {
    marginLeft: 4,
    justifyContent: 'center',
    alignItems: 'center',
    width: 34,
    height: 34,
  },
  searchIconContainer: {
    width: 18,
    height: 18,
  },
  searchIconCircle: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#555',
    position: 'absolute',
    top: 0,
    left: 0,
  },
  searchIconHandle: {
    width: 6,
    height: 2,
    backgroundColor: '#555',
    position: 'absolute',
    bottom: 2,
    right: 1,
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
  },
  clearButton: {
    position: 'absolute',
    right: 60,
    top: 2,
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  clearButtonText: {
    fontSize: 22,
    color: '#999',
    fontWeight: '300',
  },
  resultsContainer: {
    marginTop: 6,
    maxHeight: 240,
    borderRadius: 8,
    overflow: 'hidden',
  },
  resultsList: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 8,
  },
  resultItem: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  resultName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  resultAddress: {
    fontSize: 12,
    color: '#888',
    marginTop: 3,
  },
});
